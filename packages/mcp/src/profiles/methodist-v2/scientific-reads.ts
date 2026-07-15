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
import {
  neoGet,
  getNeo4jDriver,
  Layer2VectorStore,
  EmbedClient,
  buildSameAsClusters,
} from '@openarx/api';
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
const isProcessIdValue = (v: unknown): boolean =>
  typeof v === 'string' && PROCESS_LABELS.some((l) => v.startsWith(`${l}:`));

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
export function projectScientific(
  label: string,
  node: Record<string, unknown>,
): Record<string, unknown> | null {
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
export async function searchScientific(
  query: string,
  kinds?: string[],
  limit = 20,
  filter: RelationReadFilter = {},
): Promise<Record<string, unknown>[]> {
  const labels = (kinds && kinds.length ? kinds : [...SCIENTIFIC_LABELS]).filter((k) =>
    SCIENTIFIC.has(k),
  );
  const relationClass = filter.relation_class ?? 'epistemic';
  const lim = clampLimit(limit);
  const session = getNeo4jDriver().session();
  const results: Record<string, unknown>[] = [];
  try {
    for (const label of labels) {
      if (results.length >= lim) break;
      // §12.9 P1a: relation reads default to §7 (epistemic) via the native relation_class scalar
      // (coalesce — legacy nodes are §7); engineering/all opt-in. Non-relation labels have no class.
      const classPredicate =
        label === 'relation' && relationClass !== 'all'
          ? ` AND coalesce(n.relation_class,'epistemic') = $rclass`
          : '';
      const params: Record<string, unknown> = { q: query };
      if (classPredicate) params.rclass = relationClass;
      const r = await session.run(
        `MATCH (n:\`${label}\`) WHERE toLower(n._data) CONTAINS toLower($q)${classPredicate} RETURN n._data AS data LIMIT ${lim}`,
        params,
      );
      for (const rec of r.records) {
        const data = rec.get('data') as string | null;
        if (!data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (label === 'relation' && filter.subtype && parsed.relation !== filter.subtype) continue; // §7/eng subtype
        const proj = projectScientific(label, parsed);
        if (proj) results.push(proj);
      }
    }
  } finally {
    await session.close();
  }
  return (filter.latest_only ? results.filter(notSuperseded) : results).slice(0, lim);
}

/** §12.9 P1a relation-read filter. `relation_class` defaults to 'epistemic' — scientific reads are
 *  §7-only by default (Vlad invariant), with engineering an EXPLICIT opt-in. 7p80-safe: relation_class
 *  is OUTSIDE the §4.3 hash-scope, so filtering by it never touches identity. */
export interface RelationReadFilter {
  /** 'epistemic' (default, §7 scientific) | 'engineering' (ENG_*) | 'all' (both). */
  relation_class?: 'epistemic' | 'engineering' | 'all';
  /** narrow to one relation subtype (support/extend/…/depends_on/satisfies). */
  subtype?: string;
  /** narrow by direction relative to the from-claim: 'out' = from is source; 'in' = from is target. */
  direction?: 'in' | 'out';
  /** §12.9 P1c latest_only (F-11 chain-heads): drop superseded records (is_superseded=true). Default off. */
  latest_only?: boolean;
  /** §12.9 P1c / §7.6 P2 collapse_same_as: collapse same_as-equivalent connected claims to one canonical
   *  (earliest), each carrying its same_as members. Default off. */
  collapse_same_as?: boolean;
}

/** A projected record is a "latest" head iff it is not superseded. is_superseded is a native scalar
 *  (kept by projectScientific), outside the §4.3 hash-scope. */
const notSuperseded = (rec: Record<string, unknown>): boolean => rec.is_superseded !== true;

const idOf = (rec: Record<string, unknown>): string | null =>
  typeof rec.id === 'string' ? rec.id : null;
const attestedKey = (rec: Record<string, unknown>, id: string): string =>
  `${typeof rec.attested_at === 'string' ? rec.attested_at : ''}::${id}`; // earliest attested_at, id tie-break

/** Load all same_as companion edges as {a,b} pairs for the union-find (empty on today's corpus). */
async function loadSameAsEdges(): Promise<Array<{ a: string; b: string }>> {
  const session = getNeo4jDriver().session();
  try {
    const r = await session.run(
      'MATCH (a:`claim`)-[:`SAME_AS`]->(b:`claim`) RETURN a.id AS a, b.id AS b',
    );
    return r.records
      .map((rec) => ({ a: rec.get('a') as string, b: rec.get('b') as string }))
      .filter((e) => typeof e.a === 'string' && typeof e.b === 'string');
  } finally {
    await session.close();
  }
}

/**
 * §12.9 P1c / §7.6 P2: collapse same_as-equivalent claims to ONE canonical per cluster. Reuses the §7.6
 * P2 union-find (buildSameAsClusters); canonical = EARLIEST member (attested_at, id tie-break — the §7.6
 * P2 read-election). A singleton passes through (group_size 1). Each same_as cluster present in the input
 * is represented ONCE by its canonical, augmented with same_as_group_size / _members / _matched_members.
 * Cheap on today's corpus (few/no same_as edges → fast-path singletons, no fetches).
 */
async function collapseSameAsClaims(
  claims: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const edges = await loadSameAsEdges();
  const singleton = (c: Record<string, unknown>): Record<string, unknown> => ({
    ...c,
    same_as_group_size: 1,
    same_as_members: [],
    same_as_matched_members: [idOf(c)].filter(Boolean),
  });
  if (edges.length === 0) return claims.map(singleton);
  const clusters = buildSameAsClusters(edges);
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of claims) {
    const id = idOf(c);
    if (id) byId.set(id, c);
  }
  const inputIds = [...byId.keys()];
  const out: Record<string, unknown>[] = [];
  const emitted = new Set<string>();
  for (const c of claims) {
    const id = idOf(c);
    if (!id) continue;
    const root = clusters.rootOf.get(id);
    if (!root) {
      out.push(singleton(c));
      continue;
    }
    if (emitted.has(root)) continue; // cluster already represented once
    emitted.add(root);
    const members = clusters.membersOf.get(root) ?? [id];
    const matched = inputIds.filter((mid) => clusters.rootOf.get(mid) === root);
    let canonical: Record<string, unknown> | null = null;
    let bestKey = '';
    for (const mid of members) {
      const rec = byId.get(mid) ?? (await getScientific(mid));
      if (!rec) continue;
      const key = attestedKey(rec, mid);
      if (canonical === null || key < bestKey) {
        canonical = rec;
        bestKey = key;
      }
    }
    out.push({
      ...(canonical ?? c),
      same_as_group_size: members.length,
      same_as_members: members,
      same_as_matched_members: matched,
    });
  }
  return out;
}

/** Scientific records related to a claim id via relations (both endpoints), projected. Default class
 *  scope = epistemic (§7); engineering/all are opt-in via `filter.relation_class`. */
export async function findScientific(
  fromId: string,
  filter: RelationReadFilter = {},
): Promise<{ relations: Record<string, unknown>[]; connected: Record<string, unknown>[] }> {
  const out = {
    relations: [] as Record<string, unknown>[],
    connected: [] as Record<string, unknown>[],
  };
  if (isProcessId(fromId)) return out; // never traverse from a process node
  const relationClass = filter.relation_class ?? 'epistemic';
  const session = getNeo4jDriver().session();
  const connectedIds = new Set<string>();
  try {
    // §12.9 P1a: default-epistemic class scope via the native relation_class scalar (coalesce — legacy
    // nodes with no scalar are §7/epistemic); 'engineering'/'all' opt-in. Filtered in MATCH (indexed).
    const classPredicate =
      relationClass === 'all' ? '' : ` AND coalesce(rel.relation_class,'epistemic') = $rclass`;
    const params: Record<string, unknown> = { id: fromId };
    if (relationClass !== 'all') params.rclass = relationClass;
    const r = await session.run(
      `MATCH (rel:\`relation\`) WHERE rel._data CONTAINS $id${classPredicate} RETURN rel._data AS data LIMIT 100`,
      params,
    );
    for (const rec of r.records) {
      const data = rec.get('data') as string | null;
      if (!data) continue;
      const rel = JSON.parse(data) as Record<string, unknown>;
      const isSource = rel.source_claim_id === fromId;
      const isTarget = rel.target_claim_id === fromId;
      if (!isSource && !isTarget) continue;
      if (filter.direction === 'out' && !isSource) continue; // 'out' = from-claim is the source
      if (filter.direction === 'in' && !isTarget) continue; //  'in' = from-claim is the target
      if (filter.subtype && rel.relation !== filter.subtype) continue; // exact relation subtype
      const proj = projectScientific('relation', rel);
      if (proj) out.relations.push(proj);
      const other = isSource ? rel.target_claim_id : rel.source_claim_id;
      if (typeof other === 'string' && !isProcessId(other)) connectedIds.add(other);
    }
  } finally {
    await session.close();
  }
  for (const id of connectedIds) {
    const c = await getScientific(id);
    if (c && (!filter.latest_only || notSuperseded(c))) out.connected.push(c);
  }
  if (filter.latest_only) out.relations = out.relations.filter(notSuperseded);
  // §12.9 P1c: collapse same_as-equivalent connected claims to one canonical (the relations are untouched).
  if (filter.collapse_same_as) out.connected = await collapseSameAsClaims(out.connected);
  return out;
}

// §12.9 Mode A embedder: query_text → gemini vector, the SAME model/path the layer2 claim vectors
// use (vectorize-and-store → gemini-embedding-2-preview), so the query lands in the same space.
const embedClient = new EmbedClient({
  url: process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
  secret: process.env.CORE_INTERNAL_SECRET ?? '',
});
const vectorStore = new Layer2VectorStore();

async function embedQuery(text: string): Promise<number[]> {
  const r = await embedClient.callEmbed([text], 'gemini-embedding-2-preview');
  return r.vectors[0] ?? [];
}

/**
 * §12.9 Mode A — semantic (embedding) search over methodist-published claims. The claim embedding is
 * §7-scientific BY CONSTRUCTION (vectorize-and-store excludes engineering edges from the projection),
 * so this is inherently the epistemic view — no class param (engineering-claim semantics would need a
 * separate vector, Phase 2+). Returns claim id + similarity score + a short text snippet.
 */
export async function searchClaimsSemantic(
  query: string,
  limit: number,
  opts: {
    claimStatus?: string;
    scope?: 'scientific' | 'engineering';
    latestOnly?: boolean;
    collapseSameAs?: boolean;
  } = {},
): Promise<
  Array<{
    claim_id: string;
    score: number;
    snippet: string | null;
    same_as_group_size?: number;
    same_as_members?: string[];
    same_as_matched_members?: string[];
    same_as_canonical_id?: string;
  }>
> {
  const vector = await embedQuery(query);
  if (vector.length === 0) return [];
  const scope = opts.scope ?? 'scientific';
  const must: Array<Record<string, unknown>> = [];
  if (opts.claimStatus) must.push({ key: 'claim_status', match: { value: opts.claimStatus } });
  if (opts.latestOnly) must.push({ key: 'is_superseded', match: { value: false } }); // §12.9 P1c latest_only
  // §12.9 P3 eng-search correctness: scope=engineering searches the gemini_eng (engineering-projected)
  // vector AND filters to engineering-connected claims (real approaches), so a text-similar
  // non-engineering claim can't leak into a reuse search. scientific = the §7 gemini vector (default).
  if (scope === 'engineering')
    must.push({ key: 'is_engineering_connected', match: { value: true } });
  const filter = must.length ? { must } : undefined;
  const vectorName = scope === 'engineering' ? 'gemini_eng' : 'gemini';
  const hits = await vectorStore.searchClaims(vectorName, vector, filter, limit);
  const out: Array<{
    claim_id: string;
    score: number;
    snippet: string | null;
    same_as_group_size?: number;
    same_as_members?: string[];
    same_as_matched_members?: string[];
    same_as_canonical_id?: string;
  }> = [];
  for (const h of hits) {
    const claim = await getScientific(h.claimId); // process-stripped projection; text is scientific content
    const content = (claim?.content ?? null) as Record<string, unknown> | null;
    const text = typeof content?.text === 'string' ? content.text : null;
    out.push({ claim_id: h.claimId, score: h.score, snippet: text ? text.slice(0, 240) : null });
  }
  if (!opts.collapseSameAs) return out;
  // §12.9 P1c collapse: dedup same_as-equivalent hits to one representative. For a RANKED search the
  // best-scoring member is the useful cluster face (unlike find's earliest-canonical for relationship
  // reads) — `out` is score-desc so the first hit per cluster is that best match. Carries the members.
  // singleton annotation — parity with find (tester 0348): a non-clustered hit still carries the
  // same_as_* fields (group_size 1, canonical = self) so a consumer can tell "collapse ran" uniformly.
  const asSingleton = (hit: (typeof out)[number]): (typeof out)[number] => ({
    ...hit,
    same_as_group_size: 1,
    same_as_members: [],
    same_as_matched_members: [hit.claim_id],
    same_as_canonical_id: hit.claim_id,
  });
  const edges = await loadSameAsEdges();
  if (edges.length === 0) return out.map(asSingleton);
  const clusters = buildSameAsClusters(edges);
  const seen = new Set<string>();
  const collapsed: typeof out = [];
  for (const hit of out) {
    const root = clusters.rootOf.get(hit.claim_id);
    if (!root) {
      collapsed.push(asSingleton(hit));
      continue;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    const members = clusters.membersOf.get(root) ?? [hit.claim_id];
    const matched = out
      .filter((h) => clusters.rootOf.get(h.claim_id) === root)
      .map((h) => h.claim_id);
    // §7.6 P2 identity-canonical (EARLIEST) returned alongside the best-match representative (this hit),
    // so the consumer has both the ranked face and the stable identity-canonical (contracts 0336).
    let canonicalId = hit.claim_id;
    let bestKey = '';
    for (const mid of members) {
      const rec = await getScientific(mid);
      const key = attestedKey(rec ?? {}, mid);
      if (bestKey === '' || key < bestKey) {
        bestKey = key;
        canonicalId = mid;
      }
    }
    collapsed.push({
      ...hit,
      same_as_group_size: members.length,
      same_as_members: members,
      same_as_matched_members: matched,
      same_as_canonical_id: canonicalId,
    });
  }
  return collapsed;
}

// §12.9 P1b — typed-edge traversal label-spaces. §7 (epistemic) and ENG_* (engineering) are DISJOINT:
// a class traversal walks only its own labels, so classes never confound in multi-hop (structural,
// by label-space — same guarantee as the AAR metrics). Fixed sanitized sets — never user text.
const EPISTEMIC_EDGE_LABELS = [
  'SUPPORT',
  'EXTEND',
  'QUALIFY',
  'REFUTE',
  'BACKGROUND',
  'SHARED_EVIDENCE',
  'SAME_AS',
];
const ENGINEERING_EDGE_LABELS = ['ENG_DEPENDS_ON', 'ENG_SATISFIES'];
/** Cap on the traverse reached-set (parity with the other read caps). Surfaced as `truncated`. */
const TRAVERSE_LIMIT = 200;

/** Edge label from a relation subtype value (mirrors graph-mapping.relationLabel): uppercase + sanitize,
 *  ENG_ prefix for engineering. Used to narrow a traversal to one subtype. */
function edgeLabelFor(subtype: string, relationClass: 'epistemic' | 'engineering'): string {
  const core =
    subtype
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '') || 'RELATED';
  return relationClass === 'engineering' ? `ENG_${core}` : core;
}

export interface TraverseOptions {
  relation_class?: 'epistemic' | 'engineering';
  direction?: 'in' | 'out';
  max_hops?: number;
  subtype?: string;
}

/**
 * §12.9 P1b — multi-hop traversal from a claim over the typed relation edges of ONE class. direction
 * 'out' = forward (dependencies / cited-direction); 'in' = reverse (impact set — who depends on this).
 * For engineering it also reports cycle_detected (the start claim reachable from itself = a dependency
 * cycle, which a Stage-5 assembly DAG must not contain). Class label-spaces are disjoint (non-confounding).
 */
export async function traverseScientific(
  fromId: string,
  opts: TraverseOptions = {},
): Promise<{
  reached: Array<{ claim_id: string; min_hops: number }>;
  reached_count: number;
  cycle_detected: boolean;
  truncated: boolean;
}> {
  const empty = {
    reached: [] as Array<{ claim_id: string; min_hops: number }>,
    reached_count: 0,
    cycle_detected: false,
    truncated: false,
  };
  if (isProcessId(fromId)) return empty;
  const relationClass = opts.relation_class ?? 'epistemic';
  const direction = opts.direction ?? 'out';
  const maxHops = Math.max(1, Math.min(6, Math.floor(opts.max_hops ?? 3)));
  const baseLabels =
    relationClass === 'engineering' ? ENGINEERING_EDGE_LABELS : EPISTEMIC_EDGE_LABELS;
  const labels = opts.subtype
    ? [edgeLabelFor(opts.subtype, relationClass)].filter((l) => baseLabels.includes(l))
    : baseLabels;
  if (labels.length === 0) return empty; // subtype not in this class → nothing to walk
  const relPattern = labels.map((l) => `\`${l}\``).join('|'); // labels are a fixed sanitized set — injection-safe
  const left = direction === 'in' ? '<-' : '-';
  const right = direction === 'in' ? '-' : '->';
  const session = getNeo4jDriver().session();
  try {
    const r = await session.run(
      `MATCH path = (start:\`claim\` {id:$from})${left}[:${relPattern}*1..${maxHops}]${right}(reached:\`claim\`)
       WHERE reached.id <> $from
       WITH reached.id AS cid, min(length(path)) AS hops
       RETURN cid, hops ORDER BY hops, cid LIMIT ${TRAVERSE_LIMIT}`,
      { from: fromId },
    );
    const reached = r.records.map((rec) => ({
      claim_id: rec.get('cid') as string,
      min_hops: Number(rec.get('hops')),
    }));
    let cycle_detected = false;
    if (relationClass === 'engineering') {
      const cy = await session.run(
        `MATCH (start:\`claim\` {id:$from})${left}[:${relPattern}*1..${maxHops}]${right}(start) RETURN count(*) > 0 AS cyc`,
        { from: fromId },
      );
      cycle_detected = Boolean(cy.records[0]?.get('cyc'));
    }
    // no silent truncation: surface when the reached set hit the cap so a caller on a very large
    // dependency graph knows the walk was bounded (read caps: claims 100, activities 200, traverse 200).
    return {
      reached,
      reached_count: reached.length,
      cycle_detected,
      truncated: reached.length >= TRAVERSE_LIMIT,
    };
  } finally {
    await session.close();
  }
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
    'Find scientific records related to a claim by its relations: the relations touching it + the connected records on the other endpoints. Scientific-only; process nodes never appear. Relations default to the epistemic §7 set (support/extend/qualify/refute/background/shared_evidence/same_as); pass relation_class="engineering" (or "all") to include the engineering dependency graph (ENG_* depends_on/satisfies).',
    {
      from_id: z.string().min(1),
      relation_class: z
        .enum(['epistemic', 'engineering', 'all'])
        .optional()
        .describe(
          'relation class scope — default epistemic (§7); engineering = ENG_* dependency edges; all = both',
        ),
      subtype: z
        .string()
        .optional()
        .describe('narrow to one relation subtype, e.g. support / extend / depends_on / satisfies'),
      direction: z
        .enum(['in', 'out'])
        .optional()
        .describe("'out' = relations where from_id is the source; 'in' = from_id is the target"),
      latest_only: z
        .boolean()
        .optional()
        .describe('drop superseded records — return only current chain-heads (default off)'),
      collapse_same_as: z
        .boolean()
        .optional()
        .describe(
          'collapse same_as-equivalent connected claims to one canonical (earliest), carrying same_as_members (default off)',
        ),
    },
    async ({ from_id, relation_class, subtype, direction, latest_only, collapse_same_as }) => {
      const { relations, connected } = await findScientific(from_id, {
        relation_class,
        subtype,
        direction,
        latest_only,
        collapse_same_as,
      });
      return jsonResult({ from_id, relation_count: relations.length, relations, connected });
    },
  );

  server.tool(
    'methodist_search',
    'Keyword search the scientific graph (claim/relation/activity/metric/bundle). Optionally narrow by kind. When searching relations they default to the epistemic §7 set; pass relation_class="engineering"/"all" to include engineering edges. Process records are never searched or returned. (Semantic search over claims is methodist_search_semantic.)',
    {
      query: z.string().min(1),
      kind: z.enum(['claim', 'relation', 'activity', 'metric', 'bundle']).optional(),
      relation_class: z
        .enum(['epistemic', 'engineering', 'all'])
        .optional()
        .describe(
          'when kind=relation: class scope — default epistemic (§7); engineering / all opt-in',
        ),
      subtype: z.string().optional().describe('when kind=relation: narrow to one relation subtype'),
      latest_only: z
        .boolean()
        .optional()
        .describe('drop superseded records — current chain-heads only (default off)'),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ query, kind, relation_class, subtype, latest_only, limit }) => {
      const results = await searchScientific(query, kind ? [kind] : undefined, limit, {
        relation_class,
        subtype,
        latest_only,
      });
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

  server.tool(
    'methodist_search_semantic',
    'Semantic (embedding) search over methodist-published claims — the nearest claims to a natural-language query. scope="scientific" (default) searches the §7 claim space (engineering edges excluded from the projection). scope="engineering" is reuse-discovery: it searches the engineering-projected vector, scoped to engineering-connected claims — find past engineering approaches similar to a requirement (a text-similar non-engineering claim never leaks in). Returns claim ids + similarity scores + a text snippet.',
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      scope: z
        .enum(['scientific', 'engineering'])
        .optional()
        .describe(
          'scientific (default, §7 claim space) or engineering (reuse-discovery over engineering approaches)',
        ),
      claim_status: z
        .string()
        .optional()
        .describe('optional filter on the claim_status payload field'),
      latest_only: z
        .boolean()
        .optional()
        .describe('return only current (non-superseded) claims (default off)'),
      collapse_same_as: z
        .boolean()
        .optional()
        .describe(
          'collapse same_as-equivalent hits to ONE representative — the BEST-MATCHING member (a ranked face, NOT the §7.6 identity-canonical). Returns same_as_members[] + same_as_canonical_id (the earliest, i.e. the identity-canonical). Default off.',
        ),
    },
    async ({ query, limit, scope, claim_status, latest_only, collapse_same_as }) => {
      const results = await searchClaimsSemantic(query, clampLimit(limit), {
        claimStatus: claim_status,
        scope,
        latestOnly: latest_only,
        collapseSameAs: collapse_same_as,
      });
      return jsonResult({ query, scope: scope ?? 'scientific', count: results.length, results });
    },
  );

  server.tool(
    'methodist_traverse',
    'Multi-hop traversal from a claim over typed relation edges of ONE class. Default walks the epistemic §7 edges transitively (support/extend/qualify/refute/background/shared_evidence/same_as); relation_class="engineering" walks the ENG_DEPENDS_ON/ENG_SATISFIES dependency graph. direction="out" = forward (dependencies / cited); "in" = reverse (impact set — who depends on this). For engineering it also returns cycle_detected (start claim in a dependency cycle). Class label-spaces are disjoint — a §7 walk never crosses into engineering edges and vice versa.',
    {
      from_id: z.string().min(1),
      relation_class: z
        .enum(['epistemic', 'engineering'])
        .optional()
        .describe('edge class to traverse — default epistemic (§7)'),
      direction: z
        .enum(['in', 'out'])
        .optional()
        .describe("'out' = forward (dependencies); 'in' = reverse (impact set)"),
      max_hops: z
        .number()
        .int()
        .positive()
        .max(6)
        .optional()
        .describe('transitive depth, default 3, max 6'),
      subtype: z
        .string()
        .optional()
        .describe('narrow to one edge subtype, e.g. depends_on / satisfies / support'),
    },
    async ({ from_id, relation_class, direction, max_hops, subtype }) => {
      const res = await traverseScientific(from_id, {
        relation_class,
        direction,
        max_hops,
        subtype,
      });
      return jsonResult({
        from_id,
        relation_class: relation_class ?? 'epistemic',
        direction: direction ?? 'out',
        max_hops: max_hops ?? 3,
        ...res,
      });
    },
  );
}
