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
import { ownerHashFromToken } from '../../portal-auth.js';
import { deriveSupersessors, resolveSupersedeHead } from './supersede.js';

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

/** §12.11 vsz corrected_by — a COMPUTED reverse-field (forward NOT stored, §4.2-style): the source
 *  ids of incoming correction-marked (correction=true) qualify/refute relations that TARGET this
 *  claim. The corrected claim stays FULLY immutable — nothing is written onto it (stricter ratchet
 *  than superseded_by, which materializes is_superseded). Surfaced on claim-reads only; absent ⇒ []. */
async function loadCorrectedBy(claimId: string): Promise<string[]> {
  const session = getNeo4jDriver().session();
  try {
    const r = await session.run(
      `MATCH (rel:\`relation\`) WHERE rel._data CONTAINS $id RETURN rel._data AS data LIMIT ${RELATION_READ_CAP}`,
      { id: claimId },
    );
    const out: string[] = [];
    for (const rec of r.records) {
      const data = rec.get('data') as string | null;
      if (!data) continue;
      const rel = JSON.parse(data) as Record<string, unknown>;
      // correction-marked qualify/refute edge that TARGETS this claim → its source corrects it.
      if (
        rel.correction === true &&
        rel.target_claim_id === claimId &&
        typeof rel.source_claim_id === 'string' &&
        !isProcessId(rel.source_claim_id)
      ) {
        out.push(rel.source_claim_id);
      }
    }
    return out;
  } finally {
    await session.close();
  }
}

/** Read a scientific node by id across scientific labels only. Process ids miss. */
export async function getScientific(id: string): Promise<Record<string, unknown> | null> {
  if (isProcessId(id)) return null;
  for (const label of SCIENTIFIC_LABELS) {
    const node = await neoGet(label, 'id', id);
    if (node) {
      const proj = projectScientific(label, node);
      // §12.11 vsz: surface `corrected_by` ONLY on claim reads (computed reverse-lookup; absent → omitted).
      if (proj && label === 'claim') {
        const correctedBy = await loadCorrectedBy(id);
        if (correctedBy.length > 0) proj.corrected_by = correctedBy;
        await stampSupersede([proj]);
      }
      return proj;
    }
  }
  return null;
}

/** Ceiling on how many relation rows a single node-read pulls back.
 *
 *  A cap is legitimate — a hub claim should not drag its whole neighbourhood into memory. What was
 *  wrong was that it was INVISIBLE: the query took 100 rows and said nothing, so a node with more
 *  than 100 relations returned a subset that reads exactly like a complete answer. Coverage and
 *  transferability metrics are computed on these counts, so a quiet undercount lands straight in
 *  published numbers (openarx-qbwl).
 *
 *  So: raised, and every read that hits it says so. One extra row is fetched purely to detect the
 *  overflow — if it comes back, the cap bound. */
const RELATION_READ_CAP = 500;

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
  await stampSupersede(results);
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

/** A projected record is a "latest" head iff it is not superseded.
 *
 *  This used to read the stored `is_superseded` scalar — which nothing writes, so it was NULL on
 *  every one of 3357 claims and the predicate was always true. latest_only silently filtered
 *  nothing. The value is now DERIVED from the supersedes act (see supersede.ts) and stamped onto the
 *  record before this runs, so the field it reads is an answer rather than an unmaintained cache. */
const notSuperseded = (rec: Record<string, unknown>): boolean => rec.is_superseded !== true;

/** Stamp the derived supersede state onto projected records, replacing whatever the stored (never
 *  written) scalar said. Returns the same array for convenient chaining.
 *
 *  Applied to EVERY claim-bearing read, not just the latest_only ones: a reader that asks for a
 *  record and is told `is_superseded: false` about a replaced record has been given a wrong answer,
 *  which is worse than being given none. */
async function stampSupersede(records: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const ids = records.map(idOf).filter((v): v is string => typeof v === 'string');
  if (ids.length === 0) return records;
  const supersessors = await deriveSupersessors(ids);
  for (const rec of records) {
    const id = idOf(rec);
    if (!id) continue;
    const newer = supersessors.get(id) ?? [];
    rec.is_superseded = newer.length > 0;
    if (newer.length > 0) {
      // Name the records that replace this one — a reader that learns it holds a stale version
      // needs somewhere to go, and on a fork it must see that there is more than one candidate.
      rec.superseded_by = newer;
      if (newer.length > 1) rec.supersede_ambiguous = true;
    }
  }
  return records;
}

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
): Promise<{
  relations: Record<string, unknown>[];
  connected: Record<string, unknown>[];
  /** present ONLY when the cap bound — see RELATION_READ_CAP */
  truncated?: true;
  truncated_at?: number;
}> {
  const out = {
    relations: [] as Record<string, unknown>[],
    connected: [] as Record<string, unknown>[],
    /** ★ the read hit RELATION_READ_CAP and this is a SUBSET. Present only when it happened, so a
     *  complete answer stays clean — but a partial one can never again be mistaken for complete. */
    truncated: undefined as true | undefined,
    truncated_at: undefined as number | undefined,
  };
  let truncated = false;
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
      `MATCH (rel:\`relation\`) WHERE rel._data CONTAINS $id${classPredicate} RETURN rel._data AS data LIMIT ${RELATION_READ_CAP + 1}`,
      params,
    );
    // The +1 row is the overflow probe: getting it back means the cap bound and this answer is a
    // subset. Say so rather than letting a partial neighbourhood pass for the whole one.
    if (r.records.length > RELATION_READ_CAP) {
      truncated = true;
      r.records.length = RELATION_READ_CAP;
    }
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
    if (c) out.connected.push(c);
  }
  // Derive supersede state for both sides before filtering: the stored scalar is never written, so
  // filtering on it dropped nothing at all (openarx-z2bj).
  if (truncated) {
    out.truncated = true;
    out.truncated_at = RELATION_READ_CAP;
  }
  await stampSupersede(out.relations);
  await stampSupersede(out.connected);
  if (filter.latest_only) {
    out.relations = out.relations.filter(notSuperseded);
    out.connected = out.connected.filter(notSuperseded);
  }
  // §12.9 P1c: collapse same_as-equivalent connected claims to one canonical (the relations are untouched).
  if (filter.collapse_same_as) out.connected = await collapseSameAsClaims(out.connected);
  return out;
}

// §12.9 Mode A embedder: query_text → gemini vector, the SAME model/path the layer2 claim vectors
// use (vectorize-and-store → gemini-embedding-2-preview), so the query lands in the same space.
// Built on first use, not at import: EmbedClient throws without a secret, so constructing it at
// module scope made merely IMPORTING this file fail wherever the secret is absent — which is every
// test of the pure search logic, none of which embeds anything.
let embedClient: EmbedClient | undefined;
function getEmbedClient(): EmbedClient {
  embedClient ??= new EmbedClient({
    url: process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
    secret: process.env.CORE_INTERNAL_SECRET ?? '',
  });
  return embedClient;
}
const vectorStore = new Layer2VectorStore();

async function embedQuery(text: string): Promise<number[]> {
  const r = await getEmbedClient().callEmbed([text], 'gemini-embedding-2-preview');
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
  // latest_only is NOT pushed into the Qdrant filter. That payload field is written once, when the
  // claim is published, and never revisited — so a claim superseded afterwards still carries
  // is_superseded:false and passed the filter, while the filter LOOKED like it was working. The
  // superseded hits are dropped after the search instead, against the derived state (openarx-z2bj).
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
  // Derived supersede state for the whole page in one query, so latest_only means what it says.
  const supersededHits = opts.latestOnly
    ? await deriveSupersessors(hits.map((h) => h.claimId))
    : new Map<string, string[]>();
  for (const h of hits) {
    if ((supersededHits.get(h.claimId)?.length ?? 0) > 0) continue; // replaced — not a current version
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
        .describe(
          "'out' = relations where from_id is the source; 'in' = from_id is the target. This filters " +
            'the READ; it is not the `direction` field stored on a relation record, which is a different ' +
            'thing that happens to share the name — never copy in/out into a record you submit.',
        ),
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
    async (args) => {
      const { from_id, relation_class, subtype, direction, latest_only, collapse_same_as } = args;
      // Log the arguments AS RECEIVED. A ward reported 0 relations for a node where the same tool
      // with an explicit direction returned 2 and 1 — impossible under this handler's logic, which
      // filters direction in memory AFTER the query and so cannot return fewer without the filter
      // than with it. Every explanation from the code was checked and refuted (one implementation,
      // deployed artifact matches source, the id occurs in exactly 3 edges so the LIMIT never
      // binds). What has NOT been observed is what the server actually received: the client is known
      // to transform payloads, so the object the agent composed is not necessarily the object that
      // arrived. Infer nothing further until this line prints.
      console.error(
        JSON.stringify({
          at: 'methodist_find.args-received',
          keys: Object.keys(args),
          direction: direction === undefined ? '(absent)' : direction,
          relation_class: relation_class === undefined ? '(absent)' : relation_class,
          subtype: subtype === undefined ? '(absent)' : subtype,
          latest_only: latest_only === undefined ? '(absent)' : latest_only,
          collapse_same_as: collapse_same_as === undefined ? '(absent)' : collapse_same_as,
        }),
      );
      const { relations, connected, truncated, truncated_at } = await findScientific(from_id, {
        relation_class,
        subtype,
        direction,
        latest_only,
        collapse_same_as,
      });
      return jsonResult({
        from_id,
        relation_count: relations.length,
        relations,
        connected,
        // Only when the cap bound: a caller counting a node's relations must be able to tell a
        // complete count from a subset (openarx-qbwl).
        ...(truncated ? { truncated: true, truncated_at, note: `Only the first ${truncated_at} relations of this node are shown — the count is a SUBSET, not the total.` } : {}),
      });
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
    'Explore a topic ACROSS PUBLISHED CLAIMS in the layer-2 knowledge graph (keyword match on claim text). ' +
      'Searches CLAIMS, not papers — for the conceptual landscape of the PAPER corpus use explore_topic, which ' +
      'clusters chunks of documents instead. Scientific-only; a lightweight entry into the graph — pair with ' +
      'methodist_find to walk relations from a hit.',
    { topic: z.string().min(1), limit: z.number().int().positive().max(100).optional() },
    async ({ topic, limit }) => {
      const claims = await searchScientific(topic, ['claim'], limit);
      return jsonResult({ topic, count: claims.length, claims });
    },
  );

  server.tool(
    'find_related_claims',
    'Association search over published claims: what else does the graph already know that bears on THIS claim. ' +
      'Searched by the claim\'s OWN stored vector, so it is like-for-like and costs no embedding call — this is the ' +
      'by-EXAMPLE sibling of methodist_search_semantic, which searches by free TEXT. Use it before creating a claim ' +
      '(is this already established?), when building on prior work, and at cycle closeouts where the methodology ' +
      'already requires citing rather than re-minting. ' +
      'FIELDS: score_gemini / score_qwen are per-space scores, and when a space is queried EVERY hit gets its score ' +
      '(a hit missing from that space\'s own top-K is scored directly, so a blank is never a hidden low score). ' +
      'similarity_agreement="both_spaces" means two INDEPENDENT vector spaces agree the two claims are SIMILAR; ' +
      '"single_space" means both were queried and only one cleared the floor — a real disagreement; ' +
      '★ "not_measured" means only one space was queried (the default), so agreement was NEVER TESTED — read it as ' +
      'the absence of a question, never as a negative answer. Pass vector="both" to actually test agreement. ' +
      'None of this says whether the found claim is TRUE; its verification status is the separate ' +
      'verification_outcome field. ' +
      'ownership="own" | "foreign" | "unknown": self-corroboration is weaker evidence, and "unknown" (provenance not ' +
      'establishable) counts as NEITHER — it earns no independence credit and no right to supersede, and you must ' +
      'record in your journal that the origin could not be established. ' +
      'SAME_AS: when a cluster is collapsed the returned representative is the BEST-MATCHING member, NOT the §7.6 ' +
      'identity-canonical (which is the earliest and is returned alongside as same_as_canonical_id). ' +
      'LINKING: cite/link link_target_id, not the hit id — it is the canonical mapped to its current version. When ' +
      'link_target_followed_chain is true the target was superseded-forward and its CONTENT may differ from the hit ' +
      'that matched. If link_target_ambiguous is true, TWO OR MORE records supersede the same one — there is no single '+
      'current version; read link_target_candidates and choose deliberately rather than citing either as the answer. ' +
      'you matched: read it before linking. ' +
      'Read-only: never merges, never proposes a merge, never writes.',
    {
      claim_id: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      vector: z
        .enum(['gemini', 'qwen', 'both'])
        .optional()
        .describe('search space — default gemini (primary); qwen = the alt space; both = fused (NOT the default)'),
      latest_only: z.boolean().optional().describe('exclude superseded claims (default TRUE)'),
      exclude_same_as: z
        .boolean()
        .optional()
        .describe("drop members of the ANCHOR's own same_as cluster — they are the same claim (default TRUE)"),
      collapse_same_as: z
        .boolean()
        .optional()
        .describe('represent each same_as cluster once, by its best match (default TRUE)'),
      min_score: z
        .number()
        .optional()
        .describe('raise the similarity floor above the codified 0.62; it can only be raised, never lowered'),
    },
    async ({ claim_id, limit, vector, latest_only, exclude_same_as, collapse_same_as, min_score }, extra) => {
      const out = await findRelatedClaims(claim_id, clampLimit(limit), {
        vector,
        latestOnly: latest_only,
        excludeSameAs: exclude_same_as,
        collapseSameAs: collapse_same_as,
        minScore: min_score,
        callerOwnerHash: ownerHashFromToken(
          (extra as { authInfo?: { token?: { userId?: string } } })?.authInfo?.token,
        ),
      });
      if (!out) return jsonResult({ error: 'unknown claim_id', claim_id });
      return jsonResult(out);
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
    'Multi-hop traversal from a claim over typed relation edges of ONE class. Default walks the epistemic §7 edges transitively (support/extend/qualify/refute/background/shared_evidence/same_as); relation_class="engineering" walks the ENG_DEPENDS_ON/ENG_SATISFIES dependency graph. direction="out" = forward (dependencies / cited); "in" = reverse (impact set — who depends on this). ★ This `direction` is the TRAVERSAL direction of the read and has NOTHING to do with the `direction` FIELD on a relation record — different thing, same name. Do not copy in/out into a record. For engineering it also returns cycle_detected (start claim in a dependency cycle). Class label-spaces are disjoint — a §7 walk never crosses into engineering edges and vice versa.',
    {
      from_id: z.string().min(1),
      relation_class: z
        .enum(['epistemic', 'engineering'])
        .optional()
        .describe('edge class to traverse — default epistemic (§7)'),
      direction: z
        .enum(['in', 'out'])
        .optional()
        .describe(
          "'out' = forward (dependencies); 'in' = reverse (impact set). TRAVERSAL direction of this read — " +
            'NOT the `direction` field of a relation record, which is a different thing with the same name.',
        ),
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

// ─── B3: find_related_claims — by-example association search (Scope-B, epic openarx-lsqk) ─────
//
// Sibling of searchClaimsSemantic, not a replacement: that one answers "claims near this TEXT",
// this one answers "claims near THIS CLAIM". The difference is not cosmetic — the anchor's STORED
// vector was built from the §5.4.2 projection (run-context + 1-hop edges + caveats), which retyping
// the claim's text cannot reproduce, and reusing it costs no model call.
//
// Contract constraints deliberately encoded here (see docs/qwen_scopeB_B3_find_related_claims_design.md):
//  • DEFAULT vector = gemini. Fusion is available via vector='both' but is NOT the default —
//    "both degrades" was measured with the poor specter2 and its re-validation with qwen has not
//    happened; gemini stays primary until then. Both per-space scores are returned separately, so
//    the default can flip later without touching the contract (and they are IdeaRank-consumable).
//  • The floor is a NOISE floor under a rank-based top-K, NOT an absolute-threshold gate (that is
//    dedup). min_score may only RAISE it: a codified value any caller could lower by parameter
//    would not be codified.
//  • The thresholds are CLAIM-SCALE. Claim projections share boilerplate, so the negative baseline
//    sits ~0.44 (not the ~0.1 of bare text) and the usable headroom is only ~0.22. Do NOT "correct"
//    0.62 from a bare-text distribution.
//  • Ownership is resolved from the run's owner_hash (sha256(userId), refresh-immune), NEVER from
//    attester_id — that field holds the (userId, tokenId) credential composite, which ROTATES on
//    token refresh, so comparing it would label a ward's own earlier claims as foreign and fabricate
//    independent corroboration exactly where the methodology checks for it.

/** Codified association floor (r6z definitive verdict, range 0.60-0.65). CLAIM-SCALE — see above. */
const ASSOCIATION_FLOOR = 0.62;

export type ClaimOwnership = 'own' | 'foreign' | 'unknown';

/** The association floor, clamped. Pure so the rule is exhaustively testable: the codified 0.62 may
 *  be RAISED by a caller but never lowered — a codified value any caller could lower by parameter is
 *  not codified. It is a NOISE floor beneath a rank-based top-K, not dedup's absolute threshold. */
export function clampAssociationFloor(minScore?: number): number {
  return Number.isFinite(minScore) ? Math.max(ASSOCIATION_FLOOR, minScore as number) : ASSOCIATION_FLOOR;
}

/** own / foreign / unknown for one hit. Pure so the trap is pinned by tests rather than by comment.
 *
 *  Both hashes MUST be refresh-immune owner hashes (sha256(userId)), never the credential composite
 *  (userId, tokenId) that attester_id carries: that rotates on token refresh, so comparing it would
 *  label a ward's own earlier claims as foreign and manufacture independent corroboration exactly
 *  where the methodology checks for it.
 *
 *  `unknown` is returned whenever either side is missing — a claim with no run, or a run predating the
 *  owner_hash migration. It must NOT collapse into either answer: counted as own it would deny real
 *  independence, and counted as foreign it would invent it, which is the more dangerous error and the
 *  one that compounds a known bias (our independence metrics already over-state independence). */
export function classifyClaimOwnership(
  callerOwnerHash: string | undefined,
  claimRunOwnerHash: string | null,
): ClaimOwnership {
  if (!callerOwnerHash || !claimRunOwnerHash) return 'unknown';
  return claimRunOwnerHash === callerOwnerHash ? 'own' : 'foreign';
}

export interface RelatedClaimHit {
  claim_id: string;
  text: string | null;
  claim_status: string | null;
  verification_outcome: string | null;
  is_superseded: boolean;
  score_gemini: number | null;
  score_qwen: number | null;
  /** 'both_spaces' — both queried spaces score the hit above the floor.
   *  'single_space' — both were queried and only one clears the floor (a real disagreement).
   *  ★ 'not_measured' — only one space was queried, so agreement was never tested. Never read this
   *  as disagreement: it is the absence of a question, not a negative answer. */
  similarity_agreement: 'both_spaces' | 'single_space' | 'not_measured';
  ownership: ClaimOwnership;
  relation_count: number;
  same_as_canonical_id?: string;
  same_as_members?: string[];
  same_as_group_size?: number;
  /** The id a ward should LINK to: the §7.6 canonical mapped through its own supersede chain. */
  link_target_id?: string;
  /** True when the chain was followed, i.e. the link target is NOT the hit that matched. Supersede
   *  changes content, so the target may say something different — the ward must read it first. */
  link_target_followed_chain?: boolean;
  /** ★ two or more records supersede the same one — there is no single current version. Cite neither
   *  blindly: read link_target_candidates and decide. */
  link_target_ambiguous?: boolean;
  link_target_candidates?: string[];
}

/** owner_hash of the run that produced a claim — the only refresh-immune ownership key in the graph.
 *  Cached per call: a result set usually spans few distinct runs. */
async function runOwnerHash(runId: string | null, cache: Map<string, string | null>): Promise<string | null> {
  if (!runId) return null;
  if (cache.has(runId)) return cache.get(runId) ?? null;
  const run = (await neoGet('run', 'run_id', runId).catch(() => null)) as Record<string, unknown> | null;
  const oh = typeof run?.owner_hash === 'string' ? run.owner_hash : null;
  cache.set(runId, oh);
  return oh;
}

/** 1-hop relation degree — tells a ward whether a hit is already integrated or still isolated.
 *  Counts the §12.8 Model C companion EDGES (a relation persists as a node AND a typed edge), so
 *  this is an indexed degree lookup rather than a scan of every relation node. */
async function relationCounts(claimIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(claimIds.map((id) => [id, 0]));
  if (claimIds.length === 0) return out;
  const session = getNeo4jDriver().session();
  try {
    const res = await session.run(
      `UNWIND $ids AS cid
       MATCH (c:claim {id: cid})
       RETURN cid AS id, count { (c)--() } AS degree`,
      { ids: claimIds },
    );
    for (const rec of res.records) {
      const id = rec.get('id') as string;
      const degree = rec.get('degree');
      out.set(id, typeof degree === 'number' ? degree : Number(degree?.toNumber?.() ?? 0));
    }
    return out;
  } finally {
    await session.close();
  }
}

/** Resolve a claim to the id a ward should actually LINK to: the §7.6 canonical mapped through its
 *  OWN supersede chain to the current version.
 *
 *  Why not simply the canonical: same_as clustering and supersede are independent relations, and
 *  link-supersedes does NOT inherit same_as edges to the successor — so a superseded canonical's
 *  replacement lands OUTSIDE the cluster. "Earliest non-superseded MEMBER" would therefore return a
 *  non-superseded DUPLICATE of the outdated claim rather than its replacement. Following the chain
 *  keeps identity as identity (the canonical is untouched and stable across supersede events) while
 *  still pointing at something current. When same_as and supersedes disagree, the more specific
 *  relation wins.
 *
 *  Measured 2026-07-26: 0 of 3255 claims are superseded, so today this always returns the canonical
 *  unchanged — the divergence is degenerate but NOT impossible, and becomes live at the first
 *  supersede. `followedChain` makes the difference visible instead of merely derivable, because
 *  supersede CHANGES content: the target may say something other than the hit that was matched. */
async function resolveLinkTarget(canonicalId: string): Promise<{
  id: string;
  followedChain: boolean;
  fallback: boolean;
  /** ★ more than one record supersedes the same one — no single current version exists. The caller
   *  must surface both rather than cite one of them as if it were the answer. */
  ambiguous: boolean;
  heads?: string[];
}> {
  // Walks the DERIVED chain. This used to follow a `superseded_by` pointer that nothing writes, so
  // it never advanced — and the comment above once recorded "0 of 3255 claims are superseded",
  // which was not a measurement of the graph but of a dead field.
  const head = await resolveSupersedeHead(canonicalId);
  return {
    id: head.id,
    followedChain: head.followedChain,
    fallback: head.degraded,
    ambiguous: head.ambiguous,
    heads: head.ambiguous ? head.heads : undefined,
  };
}


/** Cosine similarity for two stored vectors. Layer-2 vectors are written L2-normalised and the
 *  collection is Cosine-distance, so the dot product IS the cosine; the norms are still divided out
 *  rather than assumed, because assuming it would silently produce nonsense if that ever changed.
 *  Returns null when either side is missing or degenerate — the caller then leaves the gap instead
 *  of inventing a number. */
function cosine(a: number[] | undefined, b: number[] | undefined): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** B3 core: claims related to an EXISTING claim, searched by that claim's STORED vector.
 *
 *  `callerOwnerHash` is the caller's refresh-immune owner hash (ownerHashFromToken), used ONLY to
 *  label each hit own/foreign/unknown. It must NOT come from attester_id: that field holds the
 *  (userId, tokenId) credential composite, which rotates on token refresh, so comparing it would
 *  mark a ward's own earlier claims as foreign and fabricate independent corroboration exactly where
 *  the methodology checks for it. */
export async function findRelatedClaims(
  claimId: string,
  limit: number,
  opts: {
    vector?: 'gemini' | 'qwen' | 'both';
    latestOnly?: boolean;
    excludeSameAs?: boolean;
    minScore?: number;
    collapseSameAs?: boolean;
    callerOwnerHash?: string;
  } = {},
): Promise<{ anchor: string; floor: number; count: number; results: RelatedClaimHit[] } | null> {
  const vectors = await vectorStore.getClaimVectors(claimId);
  if (!vectors) return null; // unknown claim id — the caller reports it, we do not invent hits
  // DEFAULT gemini: the contract keeps gemini primary until the "both degrades" verdict (measured
  // with the poor specter2) is re-validated with qwen. Fusion is available but never the default.
  const mode = opts.vector ?? 'gemini';
  // The floor may only be RAISED. A codified value any caller could lower by parameter is not
  // codified. NB this is a NOISE floor under a rank-based top-K, not dedup's absolute threshold.
  const floor = clampAssociationFloor(opts.minScore);

  // No is_superseded in the Qdrant filter: that payload value is stamped at publish time and never
  // updated, so it said "current" about every claim, including replaced ones — and latest_only
  // DEFAULTS to true here, which made it the default guarantee that was false (openarx-z2bj).
  // Superseded hits are dropped below against the derived state instead.
  const filter = undefined;
  const dropSuperseded = opts.latestOnly !== false;

  const wide = Math.min(limit * 3, 50);
  const spaces: Array<['gemini' | 'specter2', number[] | undefined]> = [];
  if (mode === 'gemini' || mode === 'both') spaces.push(['gemini', vectors.gemini]);
  if (mode === 'qwen' || mode === 'both') spaces.push(['specter2', vectors.specter2]);

  const scores = new Map<string, { gemini?: number; qwen?: number }>();
  for (const [name, vec] of spaces) {
    if (!vec || vec.length === 0) continue; // slot empty for this claim — skip, do not fail
    for (const hit of await vectorStore.searchClaims(name, vec, filter, wide)) {
      if (hit.claimId === claimId) continue; // the anchor is not related to itself
      const entry = scores.get(hit.claimId) ?? {};
      if (name === 'gemini') entry.gemini = hit.score;
      else entry.qwen = hit.score;
      scores.set(hit.claimId, entry);
    }
  }
  // ── fill in the scores the searches did not return ──────────────────────────────────────────
  // Each space is searched independently and returns its OWN top-K, so a hit found in one list is
  // frequently absent from the other — measured 8 of 20 on a single anchor. That absence used to be
  // indistinguishable from "scored below the floor", which gave one observable field three different
  // meanings and made the agreement signal read far more pessimistic than reality.
  //
  // Both vectors are stored, so the missing score is computable rather than inferable: fetch the
  // hits' vectors once and take the cosine against the anchor. After this, a missing score means the
  // space was not queried at all — one meaning, not three — and 'agreement' measures agreement
  // instead of the overlap of two top-K lists.
  const queried = new Set(spaces.filter(([, v]) => v && v.length > 0).map(([n]) => n));
  const needsFill = [...scores.entries()].filter(
    ([, sc]) => (queried.has('gemini') && sc.gemini === undefined) || (queried.has('specter2') && sc.qwen === undefined),
  );
  if (needsFill.length > 0) {
    const fetched = await vectorStore.getClaimVectorsBatch(needsFill.map(([id]) => id));
    for (const [id, sc] of needsFill) {
      const v = fetched.get(id);
      if (!v) continue; // no stored vectors for this hit — leave the gap rather than invent a number
      if (queried.has('gemini') && sc.gemini === undefined && vectors.gemini) {
        const s2 = cosine(vectors.gemini, v.gemini);
        if (s2 !== null) sc.gemini = s2;
      }
      if (queried.has('specter2') && sc.qwen === undefined && vectors.specter2) {
        const s2 = cosine(vectors.specter2, v.specter2);
        if (s2 !== null) sc.qwen = s2;
      }
    }
  }

  // Keep a hit if ANY searched space puts it above the floor; agreement is reported, not required.
  const aboveFloor = [...scores.entries()].filter(
    ([, s]) => (s.gemini ?? 0) >= floor || (s.qwen ?? 0) >= floor,
  );
  const supersededHits = dropSuperseded
    ? await deriveSupersessors(aboveFloor.map(([id]) => id))
    : new Map<string, string[]>();
  const kept = aboveFloor.filter(([id]) => (supersededHits.get(id)?.length ?? 0) === 0);
  const ranked = kept
    .sort((a, b) => Math.max(b[1].gemini ?? 0, b[1].qwen ?? 0) - Math.max(a[1].gemini ?? 0, a[1].qwen ?? 0))
    .slice(0, limit);
  if (ranked.length === 0) return { anchor: claimId, floor, count: 0, results: [] };

  // ── same_as handling ───────────────────────────────────────────────────────────────────────
  // Two DIFFERENT operations, each with its own switch (they were conflated in the first design):
  //  exclude — drop hits that are in the ANCHOR's cluster: they are the same claim under another id,
  //            so returning them answers "it resembles itself".
  //  collapse — represent a cluster INSIDE the results once. This tool returns a ranked top-K, and
  //            five members of one cluster would spend five slots on one piece of knowledge.
  // Both default ON here, deliberately diverging from the codified default-off of the relationship
  // reads, where the result set is not rank-limited and so has nothing to lose.
  const edges = await loadSameAsEdges();
  const clusters = edges.length > 0 ? buildSameAsClusters(edges) : null;
  let selected = ranked;
  if (clusters && opts.excludeSameAs !== false) {
    const anchorRoot = clusters.rootOf.get(claimId);
    if (anchorRoot) selected = selected.filter(([id]) => clusters.rootOf.get(id) !== anchorRoot);
  }
  const clusterInfo = new Map<string, { canonical: string; members: string[] }>();
  if (clusters && opts.collapseSameAs !== false) {
    const emitted = new Set<string>();
    const collapsed: typeof selected = [];
    for (const entry of selected) {
      const root = clusters.rootOf.get(entry[0]);
      if (!root) {
        collapsed.push(entry);
        continue;
      }
      if (emitted.has(root)) continue; // cluster already represented by its BEST-scoring member
      emitted.add(root);
      const members = clusters.membersOf.get(root) ?? [entry[0]];
      // §7.6 canonical = EARLIEST member. `selected` is score-desc, so `entry` is the best match —
      // representative ≠ canonical here, and that divergence is stated in the tool description.
      const canonical = [...members].sort()[0];
      clusterInfo.set(entry[0], { canonical, members });
      collapsed.push(entry);
    }
    selected = collapsed;
  }

  const degrees = await relationCounts(selected.map(([id]) => id));
  const ownerCache = new Map<string, string | null>();
  const results: RelatedClaimHit[] = [];
  for (const [id, s] of selected) {
    const node = (await getScientific(id).catch(() => null)) as Record<string, unknown> | null;
    const content = (node?.content ?? null) as Record<string, unknown> | null;
    const runId = typeof node?.run_id === 'string' ? node.run_id : null;
    const owner = await runOwnerHash(runId, ownerCache);
    // Three-valued on purpose: silently calling an old claim "foreign" would hand the ward a false
    // independent corroboration. `unknown` counts as neither — no independence credit, no
    // supersede rights — and the ward must record that it could not be established.
    const ownership = classifyClaimOwnership(opts.callerOwnerHash, owner);
    const bothOverFloor = (s.gemini ?? 0) >= floor && (s.qwen ?? 0) >= floor;
    results.push({
      claim_id: id,
      text: typeof content?.text === 'string' ? content.text : null,
      claim_status: typeof node?.claim_status === 'string' ? node.claim_status : null,
      verification_outcome:
        typeof node?.verification_outcome === 'string' ? node.verification_outcome : null,
      is_superseded: node?.is_superseded === true,
      score_gemini: s.gemini ?? null,
      score_qwen: s.qwen ?? null,
      // Three-valued, because the two-valued label conflated "the other space disagreed" with "the
      // other space was never asked" — and a ward reading single_space on a default call was being
      // told a negative answer to a question nobody put. 'not_measured' says so outright.
      similarity_agreement: !queried.has('specter2') || !queried.has('gemini')
        ? 'not_measured'
        : bothOverFloor
          ? 'both_spaces'
          : 'single_space',
      ownership,
      relation_count: degrees.get(id) ?? 0,
    });
    const info = clusterInfo.get(id);
    const hit = results[results.length - 1];
    if (info) {
      hit.same_as_canonical_id = info.canonical;
      hit.same_as_members = info.members;
      hit.same_as_group_size = info.members.length;
    }
    const target = await resolveLinkTarget(info?.canonical ?? id);
    hit.link_target_id = target.id;
    hit.link_target_followed_chain = target.followedChain;
    // ★ A fork has no single current version. Say so instead of citing one of the competing
    // corrections as if it were the answer — picking silently is the failure this whole fix is
    // about, one level up.
    if (target.ambiguous) {
      hit.link_target_ambiguous = true;
      hit.link_target_candidates = target.heads;
    }
  }
  return { anchor: claimId, floor, count: results.length, results };
}
