/**
 * Periodic Redis → Postgres rollup for per-document request demand (openarx-1nvk).
 *
 * Mirrors lib/cost-rollup.ts. Runs in the MCP primary process (cluster-mode
 * singleton) or the sole worker (single-process mode). Every ROLLUP_INTERVAL_MS:
 *   1. SCAN MATCH 'mcp:demand:*' → live per-(day, doc) counter keys
 *   2. HGETALL each → { get_document, get_chunks }
 *   3. Parse key → (day, documentId)
 *   4. UPSERT document_demand (REPLACE counters — Redis is intra-day truth)
 *
 * Idempotent: re-running on the same Redis state yields the same PG rows. Each
 * key is an independent UPSERT — a docId absent from documents (FK) just logs and
 * skips. Failure is non-critical (analytics signal, not billing).
 */

import { pool } from '@openarx/api';
import { getRedis } from './redis.js';
import { parseDemandKey } from './demand-counters.js';

const ROLLUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SCAN_BATCH = 200;
const KEY_PATTERN = 'mcp:demand:*';

let timerHandle: NodeJS.Timeout | null = null;

/** Start the demand rollup loop. Idempotent — second call is a no-op. */
export function startDemandRollupTimer(): void {
  if (timerHandle) return;
  timerHandle = setInterval(() => {
    syncDemandOnce().catch((err) => {
      console.error('[demand-rollup] cycle error:', err instanceof Error ? err.message : err);
    });
  }, ROLLUP_INTERVAL_MS);
  if (typeof timerHandle.unref === 'function') timerHandle.unref();
  console.error(`[demand-rollup] timer started, interval=${ROLLUP_INTERVAL_MS / 1000}s`);
}

/** Stop the rollup loop (tests / graceful shutdown). */
export function stopDemandRollupTimer(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

/** Single rollup cycle. Exported for manual trigger / tests. */
export async function syncDemandOnce(): Promise<{ keysProcessed: number; rowsUpserted: number }> {
  const redis = getRedis();
  if (!redis) {
    console.error('[demand-rollup] Redis unavailable, skipping cycle');
    return { keysProcessed: 0, rowsUpserted: 0 };
  }

  const keys: string[] = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', KEY_PATTERN, 'COUNT', SCAN_BATCH);
    cursor = result[0];
    for (const k of result[1]) keys.push(k);
  } while (cursor !== '0');

  if (keys.length === 0) return { keysProcessed: 0, rowsUpserted: 0 };

  let rowsUpserted = 0;
  for (const key of keys) {
    const parsed = parseDemandKey(key);
    if (!parsed) continue;
    try {
      const fields = (await redis.hgetall(key)) as { get_document?: string; get_chunks?: string };
      const gd = parseInt(fields.get_document ?? '0', 10);
      const gc = parseInt(fields.get_chunks ?? '0', 10);
      await pool.query(
        `INSERT INTO document_demand (document_id, day, get_document_count, get_chunks_count, rollup_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (document_id, day) DO UPDATE SET
           get_document_count = EXCLUDED.get_document_count,
           get_chunks_count = EXCLUDED.get_chunks_count,
           rollup_at = now()`,
        [parsed.docId, parsed.date, gd, gc],
      );
      rowsUpserted++;
    } catch (err) {
      console.error(`[demand-rollup] failed for key=${key}:`, err instanceof Error ? err.message : err);
    }
  }

  return { keysProcessed: keys.length, rowsUpserted };
}
