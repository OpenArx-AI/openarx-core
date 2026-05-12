/**
 * Doctor check: missing Qdrant chunks.
 *
 * Detects chunks that exist in Postgres but are missing from Qdrant.
 * Fix: re-embeds missing chunks and upserts to Qdrant.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { query } from '@openarx/api';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';
import { appendProvenance } from '../../lib/provenance.js';

const log = createChildLogger('doctor:missing-qdrant');
const COLLECTION = 'chunks';
const UPSERT_BATCH = 50;
const EMBED_BATCH = 50;

interface AffectedDoc {
  documentId: string;
  sourceId: string;
  pgCount: number;
  qdrantCount: number;
  missing: number;
}

export function createMissingQdrantCheck(ctx: DoctorContext): CheckModule {
  const qdrant = new QdrantClient({
    url: ctx.qdrantUrl,
    ...(ctx.qdrantApiKey ? { apiKey: ctx.qdrantApiKey } : {}),
  });

  return {
    name: 'missing-qdrant-chunks',
    description: 'Chunks in Postgres but not in Qdrant',
    severity: 'critical',

    async detect(): Promise<CheckResult> {
      // Get all ready documents with chunk counts
      const docs = await query<{ id: string; source_id: string; pg_count: string }>(
        `SELECT d.id, d.source_id, count(c.id)::text as pg_count
         FROM documents d JOIN chunks c ON c.document_id = d.id
         WHERE d.status = 'ready'
         GROUP BY d.id, d.source_id`,
      );

      const affected: AffectedDoc[] = [];
      let totalMissing = 0;

      for (const doc of docs.rows) {
        const pgCount = parseInt(doc.pg_count, 10);

        let qdrantCount: number;
        try {
          const countResult = await qdrant.count(COLLECTION, {
            filter: { must: [{ key: 'document_id', match: { value: doc.id } }] },
            exact: true,
          });
          qdrantCount = countResult.count;
        } catch {
          qdrantCount = 0;
        }

        if (pgCount !== qdrantCount) {
          const missing = pgCount - qdrantCount;
          affected.push({
            documentId: doc.id,
            sourceId: doc.source_id,
            pgCount,
            qdrantCount,
            missing,
          });
          if (missing > 0) totalMissing += missing;
        }
      }

      if (totalMissing === 0 && affected.length === 0) {
        return { status: 'ok', message: 'All chunks synced between Postgres and Qdrant', affectedCount: 0 };
      }

      const missingDocs = affected.filter((a) => a.missing > 0);
      const orphanDocs = affected.filter((a) => a.missing < 0);

      let message = `${totalMissing} chunks missing from Qdrant (${missingDocs.length} documents)`;
      if (orphanDocs.length > 0) {
        const orphanCount = orphanDocs.reduce((s, d) => s + Math.abs(d.missing), 0);
        message += `. ${orphanCount} orphan Qdrant points (${orphanDocs.length} documents)`;
      }

      return {
        status: totalMissing > 0 ? 'error' : 'warn',
        message,
        affectedCount: totalMissing,
        details: { missingDocs, orphanDocs },
      };
    },

    async fix(): Promise<FixResult> {
      if (!ctx.embedClient) {
        return { fixed: 0, failed: 0, message: 'embedClient not available (--fix requires running services)' };
      }

      // Re-detect to get current affected docs
      const docs = await query<{ id: string; source_id: string; pg_count: string }>(
        `SELECT d.id, d.source_id, count(c.id)::text as pg_count
         FROM documents d JOIN chunks c ON c.document_id = d.id
         WHERE d.status = 'ready'
         GROUP BY d.id, d.source_id`,
      );

      let totalFixed = 0;
      let totalFailed = 0;
      let docsFixed = 0;

      for (const doc of docs.rows) {
        if (ctx.fixLimit && docsFixed >= ctx.fixLimit) break;
        const pgCount = parseInt(doc.pg_count, 10);
        let qdrantCount: number;
        try {
          const cr = await qdrant.count(COLLECTION, {
            filter: { must: [{ key: 'document_id', match: { value: doc.id } }] },
            exact: true,
          });
          qdrantCount = cr.count;
        } catch {
          qdrantCount = 0;
        }

        if (pgCount <= qdrantCount) continue; // No missing chunks

        log.info({ sourceId: doc.source_id, pgCount, qdrantCount }, 'Fixing document');

        // Find which specific chunk IDs are missing
        const pgChunks = await query<{
          id: string; qdrant_point_id: string; content: string;
          context: string; section_title: string | null; section_path: string | null;
        }>(
          `SELECT id, qdrant_point_id, content, context::text, section_title, section_path
           FROM chunks WHERE document_id = $1 ORDER BY position`,
          [doc.id],
        );

        // Check which qdrant_point_ids actually exist in Qdrant
        const pointIds = pgChunks.rows.map((c) => c.qdrant_point_id).filter(Boolean);
        const existingIds = new Set<string>();

        // Batch check existence
        for (let i = 0; i < pointIds.length; i += 100) {
          const batch = pointIds.slice(i, i + 100);
          try {
            const points = await qdrant.retrieve(COLLECTION, { ids: batch, with_vector: false, with_payload: false });
            for (const p of points) {
              existingIds.add(String(p.id));
            }
          } catch {
            // If batch fails, none exist
          }
        }

        const missingChunks = pgChunks.rows.filter((c) => !existingIds.has(c.qdrant_point_id));

        if (missingChunks.length === 0) continue;

        log.info({ sourceId: doc.source_id, missing: missingChunks.length }, 'Re-embedding missing chunks');

        // Build embedding texts
        const texts = missingChunks.map((c) => {
          const ctx = JSON.parse(c.context);
          const title = ctx.documentTitle || '';
          const section = ctx.sectionPath || ctx.sectionName || '';
          if (ctx.summary && ctx.keyConcept) {
            return `${title}. ${section}. [${ctx.keyConcept}] ${ctx.summary}\n${c.content}`;
          }
          return `${title}. ${section}. ${c.content}`;
        });

        // Embed in batches
        try {
          for (let i = 0; i < missingChunks.length; i += EMBED_BATCH) {
            const batchChunks = missingChunks.slice(i, i + EMBED_BATCH);
            const batchTexts = texts.slice(i, i + EMBED_BATCH);

            // Gemini embedding via embed-service (same path as ingest pipeline)
            const geminiResult = await ctx.embedClient!.callEmbed(batchTexts, 'gemini-embedding-2-preview');

            // SPECTER2 embedding (optional)
            let specter2Vectors: number[][] | undefined;
            try {
              const s2Result = await ctx.embedClient!.callEmbed(batchTexts, 'specter2', { timeoutMs: 300_000 });
              specter2Vectors = s2Result.vectors;
            } catch (err) {
              log.warn({ err }, 'SPECTER2 embedding failed for batch, continuing gemini-only');
            }

            // Build Qdrant points
            const points = batchChunks.map((chunk, j) => {
              const chunkCtx = JSON.parse(chunk.context);
              return {
                id: chunk.qdrant_point_id,
                vector: {
                  gemini: geminiResult.vectors[j],
                  ...(specter2Vectors?.[j] ? { specter2: specter2Vectors[j] } : {}),
                },
                payload: {
                  chunk_id: chunk.id,
                  document_id: doc.id,
                  document_title: chunkCtx.documentTitle ?? '',
                  section_title: chunk.section_title ?? '',
                  section_path: chunk.section_path ?? '',
                  position_in_document: chunkCtx.positionInDocument ?? 0,
                  total_chunks: chunkCtx.totalChunks ?? 0,
                  content: chunk.content,
                },
              };
            });

            // Upsert to Qdrant with retry
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await qdrant.upsert(COLLECTION, { points });
                totalFixed += batchChunks.length;
                break;
              } catch (err) {
                if (attempt === 2) {
                  log.error({ err, sourceId: doc.source_id, batch: i }, 'Qdrant upsert failed after 3 attempts');
                  totalFailed += batchChunks.length;
                } else {
                  await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                }
              }
            }
          }

          await appendProvenance(doc.id, {
            op: 'doctor:missing-qdrant',
            re_embedded: missingChunks.length,
          });
          docsFixed++;
          log.info({ sourceId: doc.source_id, fixed: missingChunks.length }, 'Document fixed');
        } catch (err) {
          log.error({ err, sourceId: doc.source_id }, 'Failed to fix document');
          totalFailed += missingChunks.length;
        }
      }

      return {
        fixed: totalFixed,
        failed: totalFailed,
        message: `Re-embedded and upserted ${totalFixed} chunks${totalFailed > 0 ? `, ${totalFailed} failed` : ''}`,
      };
    },
  };
}
