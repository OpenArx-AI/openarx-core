/**
 * Periodic Redis → Postgres rollup for MCP tool costs (openarx-um8r).
 *
 * Runs in MCP primary process (cluster-mode singleton) or in the sole
 * worker (single-process mode). Every ROLLUP_INTERVAL_MS:
 *
 *   1. SCAN MATCH 'mcp:cost:*' → all live counter keys
 *   2. HGETALL each → field map
 *   3. Parse key → (date, cost_key, profile)
 *   4. UPSERT mcp_tool_costs_daily (REPLACE counters — Redis IS truth)
 *
 * Idempotent: re-running on same Redis state produces same PG rows.
 * Recovery: not implemented per user direction (statistics, not billing).
 *
 * Failure modes:
 *   - Redis unavailable: skip cycle, log warn, retry next interval
 *   - PG unavailable: skip cycle, retry next interval
 *   - Partial sync (some keys fail): each key is independent UPSERT
 *
 * Documentation: see docs/mcp_cost_tracking.md.
 */

import { pool } from '@openarx/api';
import { getRedis } from './redis.js';
import { parseKey } from './cost-counters.js';

const ROLLUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SCAN_BATCH = 200;
const KEY_PATTERN = 'mcp:cost:*';

interface CounterFields {
  invocations?: string;
  errors?: string;
  llm_calls?: string;
  llm_input_tokens?: string;
  llm_output_tokens?: string;
  llm_cost_micro_usd?: string;
  embed_calls?: string;
  embed_input_tokens?: string;
  embed_cost_micro_usd?: string;
  credits_charged?: string;
  duration_ms_sum?: string;
}

let timerHandle: NodeJS.Timeout | null = null;

/** Start the rollup loop. Idempotent — second call is a no-op. */
export function startRollupTimer(): void {
  if (timerHandle) return;
  // First run immediately is too eager (service just started, Redis may
  // not have data). Wait one interval before first cycle.
  timerHandle = setInterval(() => {
    syncOnce().catch((err) => {
      console.error('[cost-rollup] cycle error:', err instanceof Error ? err.message : err);
    });
  }, ROLLUP_INTERVAL_MS);
  // Don't keep event loop alive solely for this timer — process should
  // shut down cleanly when other handles release.
  if (typeof timerHandle.unref === 'function') timerHandle.unref();
  console.error(`[cost-rollup] timer started, interval=${ROLLUP_INTERVAL_MS / 1000}s`);
}

/** Stop the rollup loop (for tests / graceful shutdown). */
export function stopRollupTimer(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

/** Single sync cycle. Exported for manual trigger / tests. */
export async function syncOnce(): Promise<{ keysProcessed: number; rowsUpserted: number }> {
  const redis = getRedis();
  if (!redis) {
    console.error('[cost-rollup] Redis unavailable, skipping cycle');
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
    const parsed = parseKey(key);
    if (!parsed) {
      console.error('[cost-rollup] could not parse key:', key);
      continue;
    }
    try {
      const fields = (await redis.hgetall(key)) as CounterFields;
      await upsertRow(parsed, fields);
      rowsUpserted++;
    } catch (err) {
      console.error(`[cost-rollup] failed for key=${key}:`, err instanceof Error ? err.message : err);
    }
  }

  return { keysProcessed: keys.length, rowsUpserted };
}

async function upsertRow(
  parsed: { date: string; costKey: string; profile: string },
  fields: CounterFields,
): Promise<void> {
  const tool = parsed.costKey.split(':')[0]; // 'find_evidence:fast' → 'find_evidence'
  const llmCostUsd = parseInt(fields.llm_cost_micro_usd ?? '0', 10) / 1_000_000;
  const embedCostUsd = parseInt(fields.embed_cost_micro_usd ?? '0', 10) / 1_000_000;

  await pool.query(
    `INSERT INTO mcp_tool_costs_daily (
       date, cost_key, tool, profile,
       invocations, errors,
       llm_calls_total, llm_input_tokens_total, llm_output_tokens_total, llm_cost_usd_total,
       embed_calls_total, embed_input_tokens_total, embed_cost_usd_total,
       credits_charged_total, duration_ms_sum, rollup_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT (date, cost_key, profile) DO UPDATE SET
       tool = EXCLUDED.tool,
       invocations = EXCLUDED.invocations,
       errors = EXCLUDED.errors,
       llm_calls_total = EXCLUDED.llm_calls_total,
       llm_input_tokens_total = EXCLUDED.llm_input_tokens_total,
       llm_output_tokens_total = EXCLUDED.llm_output_tokens_total,
       llm_cost_usd_total = EXCLUDED.llm_cost_usd_total,
       embed_calls_total = EXCLUDED.embed_calls_total,
       embed_input_tokens_total = EXCLUDED.embed_input_tokens_total,
       embed_cost_usd_total = EXCLUDED.embed_cost_usd_total,
       credits_charged_total = EXCLUDED.credits_charged_total,
       duration_ms_sum = EXCLUDED.duration_ms_sum,
       rollup_at = now()`,
    [
      parsed.date,
      parsed.costKey,
      tool,
      parsed.profile,
      parseInt(fields.invocations ?? '0', 10),
      parseInt(fields.errors ?? '0', 10),
      parseInt(fields.llm_calls ?? '0', 10),
      parseInt(fields.llm_input_tokens ?? '0', 10),
      parseInt(fields.llm_output_tokens ?? '0', 10),
      llmCostUsd,
      parseInt(fields.embed_calls ?? '0', 10),
      parseInt(fields.embed_input_tokens ?? '0', 10),
      embedCostUsd,
      parseInt(fields.credits_charged ?? '0', 10),
      parseInt(fields.duration_ms_sum ?? '0', 10),
    ],
  );
}
