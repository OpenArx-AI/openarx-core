// ── methodist-v2 type-aware graph reads (F2.5) ───────────────────────────────
//
// The exposure boundary (§12.4 / §12.5-bis, ratified by contracts). This is a
// CLEAN-PROJECTION / utility principle — NOT a "process is private" guarantee
// (that framing, old §13.3, is RETIRED in wave-v2). The scientific read surface
// projects scientific CONTENT + references to other scientific records/agents;
// process-booking (run/intent/decision ids, the internal journal track_note) is
// internal state (§12.1/§12.2) and simply is NOT in the scientific projection —
// a reference to a non-projected process node would also dangle. Enforced two ways:
//   1. reads query ONLY scientific labels — a process id never matches;
//   2. projectScientific() applies the GENERAL, name-independent rule: strip any
//      field VALUE that references a process-node id (run/intent/decision/journal);
//      keep scientific content and references to scientific records/agents.
//
// Storage keeps the full records (cycle_context stays hash-included, §4.3); the
// strip is read-time projection only.
//
// This is the read side of the wave-v2 role surface. get() is implemented here;
// find/search/explore_topic + the find/search umbrella consolidation are the
// remainder of F2.5 (bead openarx-u37t).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { neoGet, getNeo4jDriver } from '@openarx/api';
import type { AppContext } from '../../context.js';
import { jsonResult } from '../shared/helpers.js';

export const SCIENTIFIC_LABELS = ['claim', 'relation', 'activity', 'metric', 'bundle'] as const;
export const PROCESS_LABELS = ['run', 'intent', 'decision', 'journal'] as const;
const SCIENTIFIC = new Set<string>(SCIENTIFIC_LABELS);

const SKIP = Symbol('skip');
// Keys whose value IS a process-node id → dropped (the general rule, by key).
const PROCESS_ID_KEYS = new Set(['run_id', 'intent_id', 'decision_id', 'stage_id']);
// Internal-journal content (mentee intended/did/derived) — not a scientific outcome (§12.2).
const JOURNAL_KEYS = new Set(['track_note']);
// A value that points at a process node (any field) → dropped (general, by value).
const isProcessIdValue = (v: unknown): boolean => typeof v === 'string' && PROCESS_LABELS.some((l) => v.startsWith(`${l}:`));

// Recursively project a value; returns SKIP to drop the key entirely.
function projectValue(key: string, value: unknown): unknown | typeof SKIP {
  if (JOURNAL_KEYS.has(key) || PROCESS_ID_KEYS.has(key) || key.endsWith('_run_id')) return SKIP;
  if (typeof value === 'string') return isProcessIdValue(value) ? SKIP : value;
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (const item of value) {
      const p = projectValue('', item); // array items: no key context — drop process-id refs, recurse objects
      if (p !== SKIP) arr.push(p);
    }
    return arr;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = projectValue(k, v);
      if (p !== SKIP) out[k] = p;
    }
    return out; // e.g. cycle_context → run_id/stage_id dropped, cycle_type kept
  }
  return value;
}

/**
 * Project a graph node for the read surface. Returns null for a process/unknown
 * label (never exposed); otherwise the node with process-node references stripped
 * (scientific content + references to scientific records/agents kept).
 */
export function projectScientific(label: string, node: Record<string, unknown>): Record<string, unknown> | null {
  if (!SCIENTIFIC.has(label)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    const p = projectValue(k, v);
    if (p !== SKIP) out[k] = p;
  }
  return { record_type: label, ...out };
}

/** A process id can never resolve — refuse early with a clear boundary message. */
function isProcessId(id: string): boolean {
  return PROCESS_LABELS.some((l) => id.startsWith(`${l}:`));
}

/** Read a scientific node by id across scientific labels only. Process ids miss. */
export async function getScientific(id: string): Promise<Record<string, unknown> | null> {
  if (isProcessId(id)) return null;
  for (const label of SCIENTIFIC_LABELS) {
    const node = await neoGet(label, 'id', id);
    if (node) return projectScientific(label, node);
  }
  return null;
}

const clampLimit = (n?: number): number => Math.max(1, Math.min(100, Math.floor(n ?? 20)));

/**
 * Keyword search over scientific-label nodes only (process labels are never queried).
 * Semantic (embedding) search over methodist-published claims is the follow-on once
 * the layer2 vector projection lands (bd openarx-ywje).
 */
export async function searchScientific(query: string, kinds?: string[], limit = 20): Promise<Record<string, unknown>[]> {
  const labels = (kinds && kinds.length ? kinds : [...SCIENTIFIC_LABELS]).filter((k) => SCIENTIFIC.has(k));
  const lim = clampLimit(limit);
  const session = getNeo4jDriver().session();
  const results: Record<string, unknown>[] = [];
  try {
    for (const label of labels) {
      if (results.length >= lim) break;
      const r = await session.run(
        `MATCH (n:\`${label}\`) WHERE toLower(n._data) CONTAINS toLower($q) RETURN n._data AS data LIMIT ${lim}`,
        { q: query },
      );
      for (const rec of r.records) {
        const data = rec.get('data') as string | null;
        if (!data) continue;
        const proj = projectScientific(label, JSON.parse(data) as Record<string, unknown>);
        if (proj) results.push(proj);
      }
    }
  } finally {
    await session.close();
  }
  return results.slice(0, lim);
}

/** Scientific records related to a claim id via relations (both endpoints), projected. */
export async function findScientific(fromId: string): Promise<{ relations: Record<string, unknown>[]; connected: Record<string, unknown>[] }> {
  const out = { relations: [] as Record<string, unknown>[], connected: [] as Record<string, unknown>[] };
  if (isProcessId(fromId)) return out; // never traverse from a process node
  const session = getNeo4jDriver().session();
  const connectedIds = new Set<string>();
  try {
    const r = await session.run(`MATCH (rel:\`relation\`) WHERE rel._data CONTAINS $id RETURN rel._data AS data LIMIT 100`, { id: fromId });
    for (const rec of r.records) {
      const data = rec.get('data') as string | null;
      if (!data) continue;
      const rel = JSON.parse(data) as Record<string, unknown>;
      if (rel.source_claim_id === fromId || rel.target_claim_id === fromId) {
        const proj = projectScientific('relation', rel);
        if (proj) out.relations.push(proj);
        const other = rel.source_claim_id === fromId ? rel.target_claim_id : rel.source_claim_id;
        if (typeof other === 'string' && !isProcessId(other)) connectedIds.add(other);
      }
    }
  } finally {
    await session.close();
  }
  for (const id of connectedIds) {
    const c = await getScientific(id);
    if (c) out.connected.push(c);
  }
  return out;
}

export function registerScientificReads(server: McpServer, _ctx: AppContext): void {
  server.tool(
    'methodist_get',
    'Fetch a scientific record by id (claim/relation/activity/metric/bundle). Process records (run/intent/decision/journal) are never exposed — the exposure boundary (§12.4/§12.5). Process-referencing fields are stripped.',
    { id: z.string().min(1) },
    async ({ id }) => {
      const rec = await getScientific(id);
      if (!rec) return jsonResult({ found: false });
      return jsonResult({ found: true, record: rec });
    },
  );

  server.tool(
    'methodist_find',
    'Find scientific records related to a claim by its relations (support/extend/qualify/refute/…): the relations touching it + the connected records on the other endpoints. Scientific-only; process nodes never appear.',
    { from_id: z.string().min(1) },
    async ({ from_id }) => {
      const { relations, connected } = await findScientific(from_id);
      return jsonResult({ from_id, relation_count: relations.length, relations, connected });
    },
  );

  server.tool(
    'methodist_search',
    'Keyword search the scientific graph (claim/relation/activity/metric/bundle). Optionally narrow by kind. Process records are never searched or returned. (Semantic search over methodist-published claims is a follow-on pending the layer2 vector projection.)',
    {
      query: z.string().min(1),
      kind: z.enum(['claim', 'relation', 'activity', 'metric', 'bundle']).optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ query, kind, limit }) => {
      const results = await searchScientific(query, kind ? [kind] : undefined, limit);
      return jsonResult({ query, count: results.length, results });
    },
  );

  server.tool(
    'methodist_explore_topic',
    'Explore a topic: scientific claims matching the topic (keyword). Scientific-only. A lightweight entry into the graph — pair with methodist_find to walk relations.',
    { topic: z.string().min(1), limit: z.number().int().positive().max(100).optional() },
    async ({ topic, limit }) => {
      const claims = await searchScientific(topic, ['claim'], limit);
      return jsonResult({ topic, count: claims.length, claims });
    },
  );
}
