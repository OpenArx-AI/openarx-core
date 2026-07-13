// ── Layer 2 — same_as dedup primitives P2/P3 support (§7.6) ───────────────────
//
// P1 (the symmetric `same_as` relation type + its mirror-dedup at insert) lives in
// layer2-store.ts. This module holds the CLUSTER logic P2 (canonical-collapse read
// filter) and P3 (verify-event re-election) share:
//
//   - loadSameAsClusters(): read the same_as edges (graph read: SELECT over the
//     first-class relation rows), build the transitive closure into clusters, and
//     record each member's same_as degree. On Neo4j this edge-read becomes a
//     `MATCH ()-[:same_as]->()`; the union-find closure is app-side either way and
//     survives the migration unchanged (no relational-only construct — §5.3).
//   - electCanonicalId(): the read-time canonical rule from the dossier —
//     verified > convergent-degree > evidence-strength > earliest attested_at > id.
//     Pure and deterministic; the canonical is NOT stored (computed on read, like
//     the F-11 superseded_by pattern) so it re-elects for free as state changes.

import { query } from '../db/pool.js';

export interface SameAsClusters {
  /** member claim id → cluster root id (present only for claims in ≥1 same_as edge). */
  rootOf: Map<string, string>;
  /** cluster root → sorted member ids (every cluster has ≥2 members). */
  membersOf: Map<string, string[]>;
  /** member claim id → number of distinct same_as neighbours ("convergent-count"). */
  degreeOf: Map<string, number>;
}

/**
 * Build transitive-closure clusters from same_as edges (union-find). Pure — no DB —
 * so the closure logic is unit-testable. Empty maps for no edges (the common case
 * until the dedup pipeline runs), so collapse is a cheap no-op on today's corpus.
 */
export function buildSameAsClusters(edges: ReadonlyArray<{ a: string; b: string }>): SameAsClusters {
  const parent = new Map<string, string>();
  const ensure = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path-compress
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x: string, y: string): void => {
    ensure(x);
    ensure(y);
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  const neighbours = new Map<string, Set<string>>();
  const addNeighbour = (x: string, y: string): void => {
    const s = neighbours.get(x) ?? new Set<string>();
    s.add(y);
    neighbours.set(x, s);
  };

  for (const { a, b } of edges) {
    if (a === b) continue; // defensive: no self-loops (rejected at ingress)
    union(a, b);
    addNeighbour(a, b);
    addNeighbour(b, a);
  }

  const rootOf = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    rootOf.set(node, root);
    const g = groups.get(root) ?? [];
    g.push(node);
    groups.set(root, g);
  }

  const membersOf = new Map<string, string[]>();
  for (const [root, members] of groups) {
    if (members.length >= 2) membersOf.set(root, [...members].sort());
  }

  const degreeOf = new Map<string, number>();
  for (const [node, s] of neighbours) degreeOf.set(node, s.size);

  return { rootOf, membersOf, degreeOf };
}

/**
 * Load all same_as edges (graph read over the first-class relation rows) and build
 * their transitive-closure clusters. On Neo4j the edge-read becomes a
 * `MATCH ()-[:same_as]->()`; the closure stays app-side (buildSameAsClusters).
 */
export async function loadSameAsClusters(): Promise<SameAsClusters> {
  const r = await query<{ a: string; b: string }>(
    `SELECT source_claim_id AS a, target_claim_id AS b FROM layer2_relations WHERE relation = 'same_as'`,
  );
  return buildSameAsClusters(r.rows);
}

/** Minimal shape needed to elect a cluster's canonical (a SELECT * row works). */
export interface CanonicalElectRow {
  id: string;
  attested_at: string | Date;
  verification: unknown; // jsonb → { outcome?: string } | null
  content: unknown; // jsonb → { claim_strength?: number } | …
}

function isVerified(verification: unknown): boolean {
  return (
    typeof verification === 'object' &&
    verification !== null &&
    (verification as { outcome?: unknown }).outcome === 'VERIFIED'
  );
}

function claimStrength(content: unknown): number {
  if (typeof content === 'object' && content !== null) {
    const s = (content as { claim_strength?: unknown }).claim_strength;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
  }
  return 0;
}

function millis(at: string | Date): number {
  return at instanceof Date ? at.getTime() : Date.parse(at);
}

/**
 * Elect a cluster's canonical representative from its member rows (§7.6 P2).
 * Order (each level breaks the previous tie):
 *   1. verified            — a VERIFIED claim outranks an unverified one
 *   2. convergent-degree   — more independent same_as confirmations
 *   3. evidence-strength   — higher content.claim_strength (evidence-quality proxy)
 *   4. earliest attested_at — the first to assert the equivalent claim
 *   5. id ascending        — deterministic final tiebreak
 * Deterministic: identical inputs always elect the same canonical.
 */
export function electCanonicalId(rows: CanonicalElectRow[], degreeOf: Map<string, number>): string {
  if (rows.length === 0) throw new Error('electCanonicalId: empty cluster');
  const ranked = rows
    .map((row) => ({
      id: row.id,
      verified: isVerified(row.verification) ? 1 : 0,
      degree: degreeOf.get(row.id) ?? 0,
      strength: claimStrength(row.content),
      at: millis(row.attested_at),
    }))
    .sort(
      (x, y) =>
        y.verified - x.verified ||
        y.degree - x.degree ||
        y.strength - x.strength ||
        x.at - y.at ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
  return ranked[0]!.id;
}

// ── P3 support — consistency audit + re-election ─────────────────────────────

export interface SameAsAuditReport {
  cluster_count: number;
  member_count: number;
  largest_cluster: number;
  /** current canonical per cluster (computed, not stored — like F-11 superseded_by). */
  canonicals: Array<{ root: string; canonical_id: string; size: number }>;
  /** integrity anomalies (e.g. a same_as edge pointing at a claim that no longer exists). */
  issues: string[];
}

/**
 * P3 consistency-audit safety net (§7.6 P3): load every same_as cluster, elect its
 * canonical from the live member rows, and flag integrity anomalies (dangling edges).
 * Read-only — the canonical is computed, never materialized, so this is a validation
 * pass, not a write. The dedup consumer runs it periodically; also the re-election
 * primitive the future dedup cache will call.
 */
export async function auditSameAsClusters(): Promise<SameAsAuditReport> {
  const clusters = await loadSameAsClusters();
  const memberIds = [...clusters.membersOf.values()].flat();
  const rowById = new Map<string, CanonicalElectRow>();
  if (memberIds.length) {
    const rows = await query<CanonicalElectRow & Record<string, unknown>>(
      `SELECT id, attested_at, verification, content FROM layer2_claims WHERE id = ANY($1)`,
      [memberIds],
    );
    for (const row of rows.rows) rowById.set(row.id, row);
  }
  const canonicals: SameAsAuditReport['canonicals'] = [];
  const issues: string[] = [];
  let largest = 0;
  for (const [root, members] of clusters.membersOf) {
    largest = Math.max(largest, members.length);
    const memberRows = members.map((m) => rowById.get(m)).filter(Boolean) as CanonicalElectRow[];
    if (memberRows.length !== members.length) {
      issues.push(`cluster ${root}: ${members.length - memberRows.length} same_as member(s) reference a missing claim`);
    }
    if (memberRows.length === 0) continue;
    canonicals.push({ root, canonical_id: electCanonicalId(memberRows, clusters.degreeOf), size: members.length });
  }
  return {
    cluster_count: clusters.membersOf.size,
    member_count: memberIds.length,
    largest_cluster: largest,
    canonicals,
    issues,
  };
}
