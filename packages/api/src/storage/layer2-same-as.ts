// ── Layer 2 — same_as dedup primitives P2/P3 support (§7.6) ───────────────────
//
// P1 (the symmetric `same_as` relation type + its mirror-dedup at insert) lives in
// layer2-store.ts. This module holds the CLUSTER logic P2 (canonical-collapse read
// filter) and P3 (verify-event re-election) share:
//
//   - buildSameAsClusters(): from the same_as edges build the transitive closure into
//     clusters and record each member's same_as degree (pure union-find). The edge-read
//     itself is the caller's (the read-adapter reads `MATCH ()-[:same_as]->()` from Neo4j);
//     the closure is app-side and survives the migration unchanged (no relational-only
//     construct — §5.3).
//   - electCanonicalId(): the read-time canonical rule from the dossier —
//     verified > convergent-degree > evidence-strength > earliest attested_at > id.
//     Pure and deterministic; the canonical is NOT stored (computed on read, like
//     the F-11 superseded_by pattern) so it re-elects for free as state changes.

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
export function buildSameAsClusters(
  edges: ReadonlyArray<{ a: string; b: string }>,
): SameAsClusters {
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
 * KEPT-FOR-FUTURE (9xgj PG-graph cleanup, 2026-07-14): currently UNUSED — its only caller,
 * `auditSameAsClusters`, was a dead PG-query (SELECT over the dropped layer2_* tables) and was
 * removed. Retained deliberately as the reference implementation of the §7.6 canonical-election
 * rule for the planned Neo4j-dedup port (№4 / §12.6 GREEN-parity with the old PG dedup behaviour);
 * the read-adapter's collapse uses a simpler earliest-only rule, not this full ranking.
 * DELETE THIS (with its helpers + tests) when №4 lands and ports the rule to Neo4j — or if №4 is
 * dropped from the roadmap. It must NOT linger as a permanent orphan.
 *
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
