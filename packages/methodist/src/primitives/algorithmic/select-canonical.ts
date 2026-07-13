// ── select-canonical v1 (algorithmic · deterministic) ────────────────────────
//
// goal: choose the canonical member of a cluster.
// in: { cluster } · out: { canonical_id } · effects: none.
// Priority (§ dedup): verified > convergent > has-evidence > earliest(created_at).
// The cluster carries the per-record statuses (composed from read-graph upstream),
// so this primitive is pure — access []. (spec lists graph(statuses) as the logical
// source; in a methodology the statuses are fetched by read-graph and passed in.)

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface ClusterMember {
  id: string;
  verified?: boolean;
  convergent?: boolean;
  has_evidence?: boolean;
  /** ISO timestamp — earliest wins as the final tie-break */
  created_at: string;
}
interface In {
  cluster: ClusterMember[];
}
interface Out {
  canonical_id: string;
}

/** Rank tuple: higher is better; created_at ascending breaks ties (earliest wins). */
function betterThan(a: ClusterMember, b: ClusterMember): boolean {
  const rank = (m: ClusterMember): [number, number, number] => [
    m.verified ? 1 : 0,
    m.convergent ? 1 : 0,
    m.has_evidence ? 1 : 0,
  ];
  const [av, ac, ae] = rank(a);
  const [bv, bc, be] = rank(b);
  if (av !== bv) return av > bv;
  if (ac !== bc) return ac > bc;
  if (ae !== be) return ae > be;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at; // earliest
  return a.id < b.id; // stable final tie-break
}

export const selectCanonicalPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'select-canonical',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'pick the cluster canonical: verified > convergent > has-evidence > earliest',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs }) => {
    const winner = inputs.cluster.reduce((best, m) => (betterThan(m, best) ? m : best));
    return { outputs: { canonical_id: winner.id } };
  },
);
