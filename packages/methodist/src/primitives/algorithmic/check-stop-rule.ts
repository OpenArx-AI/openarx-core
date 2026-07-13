// ── check-stop-rule v1 (algorithmic · deterministic) ─────────────────────────
//
// goal: is the GO of the PREVIOUS stage recorded on the run? (the mechanical
// stop-rule — a stage may proceed only if the stage it depends on has a GO).
// in: { path_events, stage } · out: { prev_not_go, missing? } · access: none · effects: none.
// §12.1-bis (Step B): the GO evidence is a `checkpoint_go` PATH-EVENT (§12.1 — status
// and GO are derived from the path, not a stored `go_marks` cache). path_events is fed
// by a `fetch-run-path` step; check-stop-rule is now a PURE function of its inputs. The
// methodology gates on `$stop.prev_not_go`; the previous stage is `stage − 1`; a first
// stage (≤1 / non-numeric) has no predecessor → prev_not_go=false.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface PathEvent {
  type: string;
  stage?: number;
}
interface In {
  path_events?: PathEvent[];
  stage: number | string;
}
interface Out {
  prev_not_go: boolean;
  missing?: number;
}

export const checkStopRulePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'check-stop-rule',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'gate a stage on the checkpoint_go path-event of the stage it depends on',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs }) => {
    const stageNum = typeof inputs.stage === 'number' ? inputs.stage : Number(inputs.stage);
    // A first stage (≤1 or non-numeric) has no predecessor — the rule passes.
    if (!Number.isFinite(stageNum) || stageNum <= 1) {
      return { outputs: { prev_not_go: false } };
    }
    const prev = stageNum - 1;
    const hasGo = (inputs.path_events ?? []).some((e) => e.type === 'checkpoint_go' && e.stage === prev);
    return hasGo ? { outputs: { prev_not_go: false } } : { outputs: { prev_not_go: true, missing: prev } };
  },
);
