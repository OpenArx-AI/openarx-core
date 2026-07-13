// ── fetch-run-state v1 (retrieval · deterministic) ───────────────────────────
//
// goal: restore a run's state / current dose ("where am I").
// in: { run_id } · out: FLAT run fields (dose, cycle, stage, status, parent_run_id, …)
//   · access: run-state · effects: none.
// FLAT by contract: the methodology addresses run fields directly — $runst.dose,
// $runst.cycle, $runst.stage, $runst.status (checkpoint/course/consult/get_current_dose).
// A missing run is a valid "no" → returned.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  run_id: string;
}
type Out = Record<string, unknown>;

export const fetchRunStatePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'fetch-run-state',
    version: 'v1',
    kind: 'retrieval',
    goal: 'restore a run object (cycle, stage, GO, status, parent_run_id)',
    access: ['run-state'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const node = (await ctx.read('run-state').get(inputs.run_id)) as Record<string, unknown> | undefined;
    if (node === undefined) return { control: 'returned', outputs: {} };
    // Expose run fields FLAT with `stage` aliased to current_stage ($runst.stage).
    return { outputs: { ...node, stage: node.current_stage } };
  },
);
