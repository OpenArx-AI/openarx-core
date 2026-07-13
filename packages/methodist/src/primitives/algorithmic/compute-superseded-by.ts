// ── compute-superseded-by v1 (algorithmic · deterministic) ───────────────────
//
// goal: compute the supersede marking + latest pointer for old_ref → new_ref.
// in: { old_ref, new_ref } · out: { superseded_by, latest } · effects: none (computation
// only; the write happens at commit via link-supersedes). new_ref is the tip, so it
// becomes both the superseded_by target of old_ref and the chain's latest.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  old_ref: string;
  new_ref: string;
}
interface Out {
  superseded_by: Record<string, string>;
  latest: string;
}

export const computeSupersededByPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'compute-superseded-by',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'compute superseded_by marking and latest pointer for a supersede',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs }) => ({
    outputs: { superseded_by: { [inputs.old_ref]: inputs.new_ref }, latest: inputs.new_ref },
  }),
);
