/**
 * Doctor check: partial chunks (openarx-q2eh).
 *
 * Chunks with `status='indexed_partial'` have a Gemini vector in Qdrant but
 * the SPECTER2 named vector was never written (SPECTER2 was unavailable at
 * embed time). Search quality degrades since specter-based similarity falls
 * back to gemini-only. This check lists affected chunks and (in --fix mode)
 * re-embeds them via SPECTER2 and upserts the missing named vector.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { query } from '@openarx/api';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';

const log = createChildLogger('doctor:partial-chunks');
const COLLECTION = 'chunks';
const EMBED_BATCH = 50;

interface PartialRow {
  id: string;
  document_id: string;
  qdrant_point_id: string | null;
  content: string;
  context: string;
  section_title: string | null;
  section_path: string | null;
}

export function createPartialChunksCheck(ctx: DoctorContext): CheckModule {
  const qdrant = new QdrantClient({
    url: ctx.qdrantUrl,
    ...(ctx.qdrantApiKey ? { apiKey: ctx.qdrantApiKey } : {}),
  });

  return {
    name: 'partial-chunks',
    description: 'Chunks with indexed_partial status (missing SPECTER2 vector)',
    severity: 'medium',

    async detect(): Promise<CheckResult> {
      const result = await query<{ cnt: string; docs: string }>(
        `SELECT count(*)::text AS cnt, count(DISTINCT document_id)::text AS docs
           FROM chunks
          WHERE status = 'indexed_partial'`,
      );
      const count = parseInt(result.rows[0]?.cnt ?? '0', 10);
      const docs = parseInt(result.rows[0]?.docs ?? '0', 10);

      if (count === 0) {
        return { status: 'ok', message: 'No partial chunks', affectedCount: 0 };
      }
      return {
        status: 'warn',
        message: `${count} chunks across ${docs} documents missing SPECTER2 vector`,
        affectedCount: count,
      };
    },

    async fix(): Promise<FixResult> {
      if (!ctx.embedClient) {
        return { fixed: 0, failed: 0, message: 'embedClient not available (--fix requires running services)' };
      }

      const limit = ctx.fixLimit ?? 10_000;
      const result = await query<PartialRow>(
        `SELECT id, document_id, qdrant_point_id, content,
                context::text AS context, section_title, section_path
           FROM chunks
          WHERE status = 'indexed_partial'
            AND qdrant_point_id IS NOT NULL
          ORDER BY indexed_at NULLS FIRST
          LIMIT $1`,
        [limit],
      );

      if (result.rows.length === 0) {
        return { fixed: 0, failed: 0, message: 'No partial chunks to fix' };
      }

      let fixed = 0;
      let failed = 0;

      for (let i = 0; i < result.rows.length; i += EMBED_BATCH) {
        const batch = result.rows.slice(i, i + EMBED_BATCH);
        const texts = batch.map((c) => {
          const cctx = JSON.parse(c.context) as Record<string, unknown>;
          const title = (cctx.documentTitle as string) || '';
          const section = (cctx.sectionPath as string) || (cctx.sectionName as string) || '';
          const summary = cctx.summary as string | undefined;
          const keyConcept = cctx.keyConcept as string | undefined;
          if (summary && keyConcept) {
            return `${title}. ${section}. [${keyConcept}] ${summary}\n${c.content}`;
          }
          return `${title}. ${section}. ${c.content}`;
        });

        try {
          const sResult = await ctx.embedClient!.callEmbed(texts, 'specter2', { timeoutMs: 300_000 });

          // Attach specter2 to existing points (Qdrant named-vector upsert)
          const points = batch.map((chunk, j) => ({
            id: chunk.qdrant_point_id as string,
            vector: { specter2: sResult.vectors[j] },
          }));
          await qdrant.upsert(COLLECTION, { points });

          // Promote status
          await query(
            `UPDATE chunks
                SET status = 'indexed', indexed_at = now()
              WHERE id = ANY($1::uuid[])`,
            [batch.map((c) => c.id)],
          );

          fixed += batch.length;
          log.info({ fixed, batch: batch.length }, 'specter2 re-embed batch complete');
        } catch (err) {
          failed += batch.length;
          log.error({ err: err instanceof Error ? err.message : err, batch: i }, 'Batch re-embed failed');
        }
      }

      return {
        fixed, failed,
        message: `Re-embedded ${fixed} chunks, ${failed} failed${failed > 0 ? ' (check logs)' : ''}`,
      };
    },
  };
}
