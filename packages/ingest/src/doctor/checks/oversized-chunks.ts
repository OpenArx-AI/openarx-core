/**
 * Doctor check: oversized & garbage chunks.
 *
 * Detects chunks exceeding maxChunkChars. Fix: re-processes entire
 * document through the pipeline (parse → chunk → embed → index).
 */

import { query } from '@openarx/api';
import { createChildLogger } from '../../lib/logger.js';
import { PipelineOrchestrator } from '../../pipeline/orchestrator.js';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';

const log = createChildLogger('doctor:oversized-chunks');

const MAX_CHUNK_CHARS = parseInt(process.env.GUARD_MAX_CHUNK_CHARS ?? '5000', 10);
const MAX_TABLE_CHARS = 15000;    // Tables are atomic — higher threshold
const MAX_PROOF_CHARS = 10000;    // Math proofs can be long
const MAX_TEXT_CHARS = 8000;      // Regular text

interface AffectedDoc {
  documentId: string;
  sourceId: string;
  oversizedCount: number;
  maxChunkChars: number;
  totalChunks: number;
}

export function createOversizedChunksCheck(ctx: DoctorContext): CheckModule {
  return {
    name: 'oversized-chunks',
    description: `Chunks exceeding ${MAX_CHUNK_CHARS} chars`,
    severity: 'medium',

    async detect(): Promise<CheckResult> {
      // Type-aware thresholds: tables and proofs get higher limits
      const result = await query<{
        document_id: string;
        source_id: string;
        oversized_count: string;
        max_chunk_chars: string;
        total_chunks: string;
      }>(
        `SELECT d.id as document_id, d.source_id,
          count(*) FILTER (WHERE
            char_length(c.content) > CASE
              WHEN c.content ~ '\\\\begin\\{(longtable|tabular|table)' THEN $2
              WHEN c.content ~ '\\\\begin\\{proof\\}' THEN $3
              WHEN c.content ~ '\\\\bibitem' THEN 0
              ELSE $4
            END
          )::text as oversized_count,
          max(char_length(c.content))::text as max_chunk_chars,
          count(*)::text as total_chunks
         FROM documents d JOIN chunks c ON c.document_id = d.id
         WHERE d.status = 'ready'
         GROUP BY d.id, d.source_id
         HAVING count(*) FILTER (WHERE
            char_length(c.content) > CASE
              WHEN c.content ~ '\\\\begin\\{(longtable|tabular|table)' THEN $2
              WHEN c.content ~ '\\\\begin\\{proof\\}' THEN $3
              WHEN c.content ~ '\\\\bibitem' THEN 0
              ELSE $4
            END
          ) > 0
         ORDER BY max(char_length(c.content)) DESC`,
        [MAX_CHUNK_CHARS, MAX_TABLE_CHARS, MAX_PROOF_CHARS, MAX_TEXT_CHARS],
      );

      if (result.rows.length === 0) {
        return { status: 'ok', message: `No chunks exceed ${MAX_CHUNK_CHARS} chars`, affectedCount: 0 };
      }

      const affected: AffectedDoc[] = result.rows.map((r) => ({
        documentId: r.document_id,
        sourceId: r.source_id,
        oversizedCount: parseInt(r.oversized_count, 10),
        maxChunkChars: parseInt(r.max_chunk_chars, 10),
        totalChunks: parseInt(r.total_chunks, 10),
      }));

      const totalOversized = affected.reduce((s, d) => s + d.oversizedCount, 0);

      return {
        status: 'warn',
        message: `${totalOversized} chunks exceed ${MAX_CHUNK_CHARS} chars (${affected.length} documents, max ${affected[0].maxChunkChars})`,
        affectedCount: totalOversized,
        details: affected,
      };
    },

    async fix(): Promise<FixResult> {
      if (!ctx.modelRouter || !ctx.embedClient) {
        return { fixed: 0, failed: 0, message: 'ModelRouter / embedClient not available (--fix requires running services)' };
      }

      // Re-detect to get current affected docs
      const result = await query<{ document_id: string; source_id: string }>(
        `SELECT DISTINCT d.id as document_id, d.source_id
         FROM documents d JOIN chunks c ON c.document_id = d.id
         WHERE d.status = 'ready' AND char_length(c.content) > $1`,
        [MAX_CHUNK_CHARS],
      );

      if (result.rows.length === 0) {
        return { fixed: 0, failed: 0, message: 'No oversized chunks found' };
      }

      const docsToFix = ctx.fixLimit ? result.rows.slice(0, ctx.fixLimit) : result.rows;
      log.info({ documents: docsToFix.length, total: result.rows.length, limit: ctx.fixLimit }, 'Re-processing documents with oversized chunks');

      // Build a temporary orchestrator for re-processing
      const {
        PgDocumentStore,
        QdrantVectorStore,
      } = await import('@openarx/api');

      const documentStore = new PgDocumentStore();
      const vectorStore = new QdrantVectorStore();

      // Reuse model router from context, build orchestrator
      const orchestrator = new PipelineOrchestrator(
        documentStore,
        vectorStore,
        ctx.modelRouter,
        { embedClient: ctx.embedClient },
      );

      let fixed = 0;
      let failed = 0;

      for (const doc of docsToFix) {
        log.info({ sourceId: doc.source_id }, 'Re-processing document');

        try {
          // Reset to downloaded so processOne picks it up
          await documentStore.updateStatus(doc.document_id, 'downloaded', {
            step: 'doctor-fix',
            status: 'started',
            timestamp: new Date().toISOString(),
          });

          await orchestrator.processOne(doc.document_id);
          fixed++;
          log.info({ sourceId: doc.source_id }, 'Document re-processed successfully');
        } catch (err) {
          failed++;
          log.error({ sourceId: doc.source_id, err }, 'Re-processing failed');
        }
      }

      return {
        fixed,
        failed,
        message: `Re-processed ${fixed} documents${failed > 0 ? `, ${failed} failed` : ''}`,
      };
    },
  };
}
