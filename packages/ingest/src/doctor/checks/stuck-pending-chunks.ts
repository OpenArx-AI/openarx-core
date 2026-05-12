/**
 * Doctor check: stuck pending chunks (openarx-q2eh).
 *
 * Chunks persisted by chunker but never moved beyond pending_embed / embedded
 * status. Usually means the parent document was abandoned (permanent failure
 * without retry, or enrichment-triggered reindex that never completed).
 *
 * Detect: count orphans older than ORPHAN_CHUNK_TTL_DAYS (default 30).
 * Fix: hard-delete them via PgChunkStore.deleteOrphans — pipeline can still
 * re-create chunks later if the doc is retried.
 */

import { PgChunkStore, query } from '@openarx/api';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';

const TTL_DAYS = parseInt(process.env.ORPHAN_CHUNK_TTL_DAYS ?? '30', 10);

export function createStuckPendingChunksCheck(_ctx: DoctorContext): CheckModule {
  const chunkStore = new PgChunkStore();

  return {
    name: 'stuck-pending-chunks',
    description: `Chunks stuck in pending_embed/embedded state >${TTL_DAYS} days (orphans)`,
    severity: 'low',

    async detect(): Promise<CheckResult> {
      const result = await query<{ cnt: string; docs: string }>(
        `SELECT count(*)::text AS cnt, count(DISTINCT document_id)::text AS docs
           FROM chunks
          WHERE status IN ('pending_embed','embedded')
            AND created_at < now() - ($1::text || ' days')::interval`,
        [String(TTL_DAYS)],
      );
      const cnt = parseInt(result.rows[0]?.cnt ?? '0', 10);
      const docs = parseInt(result.rows[0]?.docs ?? '0', 10);

      if (cnt === 0) {
        return { status: 'ok', message: 'No stuck chunks', affectedCount: 0 };
      }
      return {
        status: 'warn',
        message: `${cnt} chunks across ${docs} documents orphaned >${TTL_DAYS}d`,
        affectedCount: cnt,
      };
    },

    async fix(): Promise<FixResult> {
      const limit = _ctx.fixLimit ?? 10_000;
      const deleted = await chunkStore.deleteOrphans(TTL_DAYS, limit);
      return {
        fixed: deleted, failed: 0,
        message: `Deleted ${deleted} orphan chunks`,
      };
    },
  };
}
