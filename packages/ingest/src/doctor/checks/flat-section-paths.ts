/**
 * Doctor check: flat-section-paths.
 *
 * Detects LaTeX documents where sectionPath == sectionName (flat, no hierarchy).
 * Fix: re-parses LaTeX source to build hierarchical name→path map,
 * updates sectionPath in context JSONB + section_path column,
 * then re-embeds affected chunks with the new path in embedding text.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { query } from '@openarx/api';
import { parseLatexSource } from '../../parsers/latex-parser.js';
import { createChildLogger } from '../../lib/logger.js';
import type { ParsedSection } from '@openarx/types';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';
import { appendProvenance } from '../../lib/provenance.js';

const log = createChildLogger('doctor:flat-section-paths');
const COLLECTION = 'chunks';
const EMBED_BATCH = 50;

function flattenSections(sections: ParsedSection[], parentPath = ''): Array<{ name: string; path: string }> {
  const result: Array<{ name: string; path: string }> = [];
  for (const s of sections) {
    const path = parentPath ? `${parentPath} > ${s.name}` : s.name;
    result.push({ name: s.name, path });
    if (s.subsections?.length) {
      result.push(...flattenSections(s.subsections, path));
    }
  }
  return result;
}

export function createFlatSectionPathsCheck(ctx: DoctorContext): CheckModule {
  const qdrant = new QdrantClient({
    url: ctx.qdrantUrl,
    ...(ctx.qdrantApiKey ? { apiKey: ctx.qdrantApiKey } : {}),
  });

  return {
    name: 'flat-section-paths',
    description: 'LaTeX documents with flat sectionPath (missing hierarchy)',
    severity: 'medium',

    async detect(): Promise<CheckResult> {
      // Find docs where ALL non-Abstract chunks are flat (no hierarchy at all).
      // Exclude docs that already have some hierarchical paths (contain '>').
      const result = await query<{ document_id: string; source_id: string; flat_chunks: string }>(
        `SELECT d.id as document_id, d.source_id, count(*)::text as flat_chunks
         FROM chunks c JOIN documents d ON c.document_id = d.id
         WHERE d.status = 'ready'
           AND d.source_format = 'latex'
           AND d.sources->'latex' IS NOT NULL
           AND c.context->>'sectionPath' = c.context->>'sectionName'
           AND c.context->>'sectionName' != 'Abstract'
           AND NOT EXISTS (
             SELECT 1 FROM chunks c2
             WHERE c2.document_id = d.id
               AND c2.context->>'sectionPath' LIKE '%>%'
           )
         GROUP BY d.id, d.source_id
         ORDER BY count(*) DESC`,
      );

      if (result.rows.length === 0) {
        return { status: 'ok', message: 'All LaTeX documents have hierarchical sectionPath', affectedCount: 0 };
      }

      const totalChunks = result.rows.reduce((s, r) => s + parseInt(r.flat_chunks, 10), 0);

      return {
        status: 'warn',
        message: `${result.rows.length} documents with flat sectionPath (${totalChunks} chunks)`,
        affectedCount: result.rows.length,
        details: { documents: result.rows.length, chunks: totalChunks },
      };
    },

    async fix(): Promise<FixResult> {
      if (!ctx.embedClient) {
        return { fixed: 0, failed: 0, message: 'embedClient not available (--fix requires running services)' };
      }

      // Get affected documents (only those with NO hierarchical paths)
      const docs = await query<{
        document_id: string; source_id: string;
        latex_path: string; root_tex: string;
      }>(
        `SELECT DISTINCT d.id as document_id, d.source_id,
          d.sources->'latex'->>'path' as latex_path,
          d.sources->'latex'->>'rootTex' as root_tex
         FROM chunks c JOIN documents d ON c.document_id = d.id
         WHERE d.status = 'ready'
           AND d.source_format = 'latex'
           AND d.sources->'latex' IS NOT NULL
           AND c.context->>'sectionPath' = c.context->>'sectionName'
           AND c.context->>'sectionName' != 'Abstract'
           AND NOT EXISTS (
             SELECT 1 FROM chunks c2
             WHERE c2.document_id = d.id
               AND c2.context->>'sectionPath' LIKE '%>%'
           )
         ORDER BY d.source_id`,
      );

      if (docs.rows.length === 0) {
        return { fixed: 0, failed: 0, message: 'No documents to fix' };
      }

      const toFix = ctx.fixLimit ? docs.rows.slice(0, ctx.fixLimit) : docs.rows;
      log.info({ count: toFix.length, total: docs.rows.length }, 'Fixing flat sectionPaths');

      let fixedDocs = 0;
      let failedDocs = 0;

      for (const doc of toFix) {
        try {
          // Step 1: Re-parse LaTeX → hierarchical sections
          const parsed = await parseLatexSource(doc.latex_path, doc.root_tex || undefined);
          const flat = flattenSections(parsed.sections);

          // Build name→path map (leaf name → full hierarchical path)
          const pathMap = new Map<string, string>();
          for (const s of flat) {
            if (!pathMap.has(s.name)) pathMap.set(s.name, s.path);
          }

          // Step 2: Get flat chunks for this document
          const chunks = await query<{
            id: string; qdrant_point_id: string; content: string;
            context: string; section_name: string;
          }>(
            `SELECT c.id, c.qdrant_point_id, c.content, c.context::text,
              c.context->>'sectionName' as section_name
             FROM chunks c WHERE c.document_id = $1
               AND c.context->>'sectionPath' = c.context->>'sectionName'
               AND c.context->>'sectionName' != 'Abstract'`,
            [doc.document_id],
          );

          if (chunks.rows.length === 0) { fixedDocs++; continue; }

          // Step 3: Update sectionPath in Postgres
          let updatedCount = 0;
          for (const chunk of chunks.rows) {
            const newPath = pathMap.get(chunk.section_name);
            if (!newPath || newPath === chunk.section_name) continue; // No hierarchy available

            await query(
              `UPDATE chunks SET
                context = jsonb_set(context, '{sectionPath}', $1::jsonb),
                section_path = $2
               WHERE id = $3`,
              [JSON.stringify(newPath), newPath, chunk.id],
            );
            updatedCount++;
          }

          if (updatedCount === 0) { fixedDocs++; continue; }

          // Step 4: Re-embed updated chunks
          // Re-read chunks to get updated context
          const updatedChunks = await query<{
            id: string; qdrant_point_id: string; content: string; context: string;
          }>(
            `SELECT c.id, c.qdrant_point_id, c.content, c.context::text
             FROM chunks c WHERE c.document_id = $1`,
            [doc.document_id],
          );

          // Build embedding texts (same formula as embedder-step.ts:22-29)
          const allChunks = updatedChunks.rows;
          const texts = allChunks.map((c) => {
            const ctxObj = JSON.parse(c.context);
            const title = ctxObj.documentTitle || '';
            const section = ctxObj.sectionPath || ctxObj.sectionName || '';
            if (ctxObj.summary && ctxObj.keyConcept) {
              return `${title}. ${section}. [${ctxObj.keyConcept}] ${ctxObj.summary}\n${c.content}`;
            }
            return `${title}. ${section}. ${c.content}`;
          });

          // Embed in batches and upsert to Qdrant
          for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
            const batchChunks = allChunks.slice(i, i + EMBED_BATCH);
            const batchTexts = texts.slice(i, i + EMBED_BATCH);

            const geminiResult = await ctx.embedClient!.callEmbed(batchTexts, 'gemini-embedding-2-preview');

            let specter2Vectors: number[][] | undefined;
            try {
              const s2Result = await ctx.embedClient!.callEmbed(batchTexts, 'specter2', { timeoutMs: 300_000 });
              specter2Vectors = s2Result.vectors;
            } catch {
              log.warn({ sourceId: doc.source_id }, 'SPECTER2 embed failed, Gemini-only');
            }

            const points = batchChunks.map((chunk, j) => {
              const ctxObj = JSON.parse(chunk.context);
              return {
                id: chunk.qdrant_point_id,
                vector: {
                  gemini: geminiResult.vectors[j],
                  ...(specter2Vectors?.[j] ? { specter2: specter2Vectors[j] } : {}),
                },
                payload: {
                  chunk_id: chunk.id,
                  document_id: doc.document_id,
                  document_title: ctxObj.documentTitle ?? '',
                  section_title: ctxObj.sectionName ?? '',
                  section_path: ctxObj.sectionPath ?? '',
                  position_in_document: ctxObj.positionInDocument ?? 0,
                  total_chunks: ctxObj.totalChunks ?? 0,
                  content: chunk.content,
                },
              };
            });

            await qdrant.upsert(COLLECTION, { points });
          }

          await appendProvenance(doc.document_id, {
            op: 'doctor:flat-section-paths',
            chunks_fixed: updatedCount,
            re_embedded: allChunks.length,
          });
          fixedDocs++;
          log.info({ sourceId: doc.source_id, updated: updatedCount, reEmbedded: allChunks.length }, 'Document fixed');
        } catch (err) {
          failedDocs++;
          log.error({ sourceId: doc.source_id, err }, 'Fix failed');
        }
      }

      return {
        fixed: fixedDocs,
        failed: failedDocs,
        message: `Fixed ${fixedDocs} documents${failedDocs > 0 ? `, ${failedDocs} failed` : ''}`,
      };
    },
  };
}
