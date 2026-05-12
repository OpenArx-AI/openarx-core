/**
 * Per-call Redis counter writes for daily MCP tool cost aggregation
 * (openarx-um8r). Pipelined HINCRBY into HASH keyed by
 * `mcp:cost:{YYYY-MM-DD}:{cost_key}:{profile}`. Hourly rollup runs
 * inside MCP primary process — see lib/cost-rollup.ts.
 *
 * Cost stored in micro-USD (integer): 1 unit = $0.000001. Prevents
 * float drift on summed values while keeping HINCRBY atomic.
 *
 * Failure is non-critical — JSONL log captures the same data per-call,
 * Redis counters are an optimisation for fast aggregation. Fire-and-
 * forget; no error propagated to MCP response path.
 */

import { getRedis } from './redis.js';
import type { UsageSnapshot } from './usage-tracker.js';

const KEY_PREFIX = 'mcp:cost';
const TTL_SECONDS = 60 * 60 * 26; // 26 hours = 24 + 2 buffer

export interface IncrementCounterInput {
  costKey: string;
  profile: string;
  isError: boolean;
  durationMs: number;
  creditsCharged: number | null;
  usage: UsageSnapshot;
}

/** UTC date in YYYY-MM-DD form — matches the daily aggregation grain. */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildKey(date: string, costKey: string, profile: string): string {
  // Sanitise — Redis key parsing relies on stable separator. cost_key
  // and profile are controlled values from getCostKey() / profile registry,
  // but defensive against unexpected colons in cost_key future variants.
  const safeCostKey = costKey.replace(/\|/g, '_');
  const safeProfile = profile.replace(/\|/g, '_');
  return `${KEY_PREFIX}:${date}:${safeCostKey}:${safeProfile}`;
}

/** Parse `mcp:cost:2026-05-08:find_evidence:fast:v1` → parts.
 *  cost_key may itself contain colons (e.g. 'find_evidence:fast'); the
 *  format is `mcp:cost:DATE:COSTKEY:PROFILE` where DATE is ISO and
 *  PROFILE is the trailing segment. Anything between is cost_key. */
export function parseKey(key: string): { date: string; costKey: string; profile: string } | null {
  if (!key.startsWith(`${KEY_PREFIX}:`)) return null;
  const rest = key.slice(KEY_PREFIX.length + 1); // strip 'mcp:cost:'
  const parts = rest.split(':');
  if (parts.length < 3) return null;
  const date = parts[0];
  const profile = parts[parts.length - 1];
  const costKey = parts.slice(1, -1).join(':');
  return { date, costKey, profile };
}

/** Convert USD float → integer micro-USD for HINCRBY. */
function toMicroUsd(usd: number): number {
  return Math.round((usd || 0) * 1_000_000);
}

export async function incrementCallCounters(input: IncrementCounterInput): Promise<void> {
  const redis = getRedis();
  if (!redis) return; // Redis unavailable — skip silently, JSONL log retains data

  const { costKey, profile, isError, durationMs, creditsCharged, usage } = input;
  const key = buildKey(utcDate(), costKey, profile);

  try {
    const pipe = redis.pipeline();
    pipe.hincrby(key, 'invocations', 1);
    if (isError) pipe.hincrby(key, 'errors', 1);
    pipe.hincrby(key, 'llm_calls', usage.llmCalls?.length ?? 0);
    pipe.hincrby(key, 'llm_input_tokens', usage.llmInputTokensTotal || 0);
    pipe.hincrby(key, 'llm_output_tokens', usage.llmOutputTokensTotal || 0);
    pipe.hincrby(key, 'llm_cost_micro_usd', toMicroUsd(usage.llmCostUsdTotal));
    pipe.hincrby(key, 'embed_calls', usage.embedCalls?.length ?? 0);
    // embed_input_tokens — sum across embed calls
    let embedInputTokens = 0;
    for (const c of usage.embedCalls ?? []) embedInputTokens += c.inputTokens || 0;
    pipe.hincrby(key, 'embed_input_tokens', embedInputTokens);
    pipe.hincrby(key, 'embed_cost_micro_usd', toMicroUsd(usage.embedCostUsdTotal));
    pipe.hincrby(key, 'credits_charged', creditsCharged ?? 0);
    pipe.hincrby(key, 'duration_ms_sum', Math.round(durationMs));
    pipe.expire(key, TTL_SECONDS);
    await pipe.exec();
  } catch {
    // Silent — JSONL log already has the data. Counter loss is acceptable.
  }
}
