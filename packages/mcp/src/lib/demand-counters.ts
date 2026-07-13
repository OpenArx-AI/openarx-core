/**
 * Per-call Redis counters for per-document request demand (openarx-1nvk).
 *
 * Mirrors lib/cost-counters.ts: pipelined HINCRBY into a HASH keyed by
 * `mcp:demand:{YYYY-MM-DD}:{documentId}` with two fields — get_document,
 * get_chunks. A ~5min rollup (lib/demand-rollup.ts) replaces these into the
 * Postgres document_demand table (Redis is the intra-day accumulator; PG is the
 * persistent store, so the TTL only needs to outlive the rollup window).
 *
 * Internal-only signal: never surfaced to agents. Fire-and-forget; failure is
 * non-critical (a lost demand tick never affects the tool response).
 */

import { getRedis } from './redis.js';

const KEY_PREFIX = 'mcp:demand';
const TTL_SECONDS = 60 * 60 * 50; // ~2 days — rolled up to PG well before expiry

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UTC date YYYY-MM-DD — matches the daily aggregation grain. */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildDemandKey(date: string, docId: string): string {
  return `${KEY_PREFIX}:${date}:${docId}`;
}

/** Parse `mcp:demand:2026-06-26:<uuid>` → parts (uuid contains no ':'). */
export function parseDemandKey(key: string): { date: string; docId: string } | null {
  if (!key.startsWith(`${KEY_PREFIX}:`)) return null;
  const rest = key.slice(KEY_PREFIX.length + 1);
  const idx = rest.indexOf(':');
  if (idx < 0) return null;
  const date = rest.slice(0, idx);
  const docId = rest.slice(idx + 1);
  if (!UUID_RE.test(docId)) return null;
  return { date, docId };
}

/**
 * Resolve the document UUID a get_document / get_chunks call targeted.
 * Prefer the resolved doc id from the result (handles arxivId lookups); fall
 * back to a UUID-shaped `id`/`documentId` argument. Returns null when no UUID
 * can be determined (e.g. arxivId-only call that returned not-found).
 */
export function demandDocId(
  args: Record<string, unknown> | undefined,
  topResults: Array<{ docId: string }> | null | undefined,
): string | null {
  const fromResult = topResults?.[0]?.docId;
  if (typeof fromResult === 'string' && UUID_RE.test(fromResult)) return fromResult;
  const argId = (args?.id ?? args?.documentId) as unknown;
  if (typeof argId === 'string' && UUID_RE.test(argId)) return argId;
  return null;
}

/** Fire-and-forget demand increment. `tool` ∈ {'get_document','get_chunks'}. */
export async function incrementDemand(tool: string, docId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const field = tool === 'get_chunks' ? 'get_chunks' : 'get_document';
  const key = buildDemandKey(utcDate(), docId);
  try {
    const pipe = redis.pipeline();
    pipe.hincrby(key, field, 1);
    pipe.expire(key, TTL_SECONDS);
    await pipe.exec();
  } catch {
    // Non-critical — demand is a derived analytics signal.
  }
}
