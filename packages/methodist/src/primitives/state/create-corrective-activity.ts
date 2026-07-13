// ── create-corrective-activity v1 (state · deterministic) ────────────────────
//
// goal: record a corrective activity that SUPERSEDES a published claim
// (GO-refinement later edits a prior claim — immutability = add + link, §7 inv-6).
// in: { run_id, target_ref, reason } · out: { activity_id } · access: none
// effects: append-only activities.
//
// Wave-v2 reconciliation (methodist, 2026-07-08): this primitive is for the
// SUPERSEDE scenario ONLY — its input is a supersede target (from
// apply-supersede-guards), NOT a checkpoint verdict's corrections. RETURN-time
// corrections are GUIDANCE and live inside the checkpoint_return outcome-activity
// (write-graph-records), not here. Supersede is tied to the gated dedup path, so
// this primitive is DORMANT in the live checkpoint this wave.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  run_id: string;
  target_ref: string;
  reason: string;
}
interface Out {
  activity_id: string;
}

export const createCorrectiveActivityPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'create-corrective-activity',
    version: 'v1',
    kind: 'state',
    goal: 'append a corrective activity linked wasInformedBy to a superseded claim',
    access: [],
    effects: ['activities'],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const { id } = await ctx.write('activities').append({
      activity_type: 'corrective',
      run_id: inputs.run_id,
      target_ref: inputs.target_ref,
      reason: inputs.reason,
      wasInformedBy: [inputs.target_ref],
    });
    return { outputs: { activity_id: id } };
  },
);
