// ── update-run-state v1 (state · deterministic) ──────────────────────────────
//
// goal: apply a run transition + emit ONE typed path-event (§12.1-bis single writer).
// Wave-v2 form (converged with methodist 2026-07-08): ONE primitive, flat optional
// fields, BRANCH BY DATA (§5.4) — it runs unconditionally and the data decides the
// effect. Covers all four call sites:
//   diagnose      → { stage, dose }                        → dose_issued
//   checkpoint    → { verdict, next_dose }                 → checkpoint_go (+advance) | checkpoint_return
//   course        → { dose_adjustment, advance_stage:false } → ask
//   report_need   → { status:'paused', need }              → report_need
// §12.1-bis (contracts 0183): update-run-state is the SINGLE writer of typed path-events.
// The events it emits (checkpoint_go/checkpoint_return/report_need/dose_issued/ask) are
// what fetch-run-path normalizes and check-stop-rule / derive-run-status read.
// in: { run_id, stage?, dose?, status?, verdict?, next_dose?, dose_adjustment?, advance_stage?, need? }
// out: { ok } · access: run-state · effects: run-state + journal (typed path-event).

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

interface RunNode {
  current_stage?: number | null;
  go_marks?: unknown[];
  status?: string;
  dose?: unknown;
  need?: unknown;
  [field: string]: unknown;
}
type Verdict = { verdict?: 'GO' | 'RETURN' } | 'GO' | 'RETURN';
interface In {
  run_id: string;
  stage?: number;
  /** the diagnosed cycle — set on the run node at diagnose so $runst.cycle resolves later */
  cycle?: string;
  dose?: unknown;
  status?: 'active' | 'paused' | 'abandoned' | 'done';
  verdict?: Verdict;
  next_dose?: unknown;
  dose_adjustment?: Record<string, unknown>;
  advance_stage?: boolean;
  need?: unknown;
}
interface Out {
  ok: true;
}

function verdictValue(v: Verdict | undefined): 'GO' | 'RETURN' | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : v.verdict;
}

export const updateRunStatePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'update-run-state',
    version: 'v1',
    kind: 'state',
    goal: 'apply a run transition (stage/dose/status/verdict/need) and mark it',
    access: ['run-state'],
    effects: ['run-state', 'journal'],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const current = (await ctx.read('run-state').get(inputs.run_id)) as RunNode | undefined;
    if (current === undefined) throw new RuntimeError('bad-output', `run '${inputs.run_id}' does not exist`);
    const next: RunNode = { ...current };
    const verdict = verdictValue(inputs.verdict);

    // §12.1-bis (anti-gaming): on a CHECKPOINT the run's stage is SERVER-TRACKED (advance
    // on GO / hold on RETURN) — inputs.stage must NOT override it, or an agent's checkpoint
    // payload.stage could forge current_stage (and past a RETURN it would stick). Only a
    // stage-setting call WITHOUT a verdict (diagnose) may set current_stage from inputs.
    if (inputs.stage !== undefined && verdict === undefined) next.current_stage = inputs.stage;
    if (inputs.cycle !== undefined) next.cycle = inputs.cycle;
    if (inputs.status !== undefined) next.status = inputs.status;
    if (inputs.need !== undefined) next.need = inputs.need;
    if (inputs.dose !== undefined) next.dose = inputs.dose;

    if (verdict === 'GO') {
      // mark GO for the stage just judged; advance unless explicitly held (course)
      next.go_marks = [...(current.go_marks ?? []), current.current_stage];
      if (inputs.advance_stage !== false) next.current_stage = (current.current_stage ?? 0) + 1;
    }
    // RETURN: no GO mark, stage stays (retry the same stage).

    if (inputs.next_dose !== undefined) next.dose = inputs.next_dose; // GO carries the next stage's dose
    if (inputs.dose_adjustment !== undefined) {
      next.dose = { ...((next.dose as Record<string, unknown> | null) ?? {}), ...inputs.dose_adjustment };
    }

    await ctx.write('run-state').put(inputs.run_id, next);

    // §12.1-bis (single path-event writer, contracts 0183): emit ONE typed path-event.
    // The store persists {run_id, event, payload}; the prior {kind,patch} shape was
    // silently DROPPED (store-provider maps only event/payload) — this replaces it with
    // the events fetch-run-path normalizes and check-stop-rule / derive-run-status read.
    // status + go_marks stay on the node until the read-side rewire lands them off it.
    let event: string | undefined;
    let payload: Record<string, unknown> = {};
    if (verdict === 'GO') {
      event = 'checkpoint_go';
      payload = { stage: current.current_stage, verdict: 'GO' };
    } else if (verdict === 'RETURN') {
      event = 'checkpoint_return';
      payload = { stage: current.current_stage, verdict: 'RETURN' };
    } else if (inputs.need !== undefined) {
      event = 'report_need';
      payload = { need: inputs.need };
    } else if (inputs.dose_adjustment !== undefined) {
      event = 'ask';
      payload = { dose_adjustment: inputs.dose_adjustment };
    } else if (inputs.dose !== undefined && inputs.stage !== undefined) {
      event = 'dose_issued';
      payload = { stage: inputs.stage };
    }
    if (event !== undefined) await ctx.write('journal').append({ run_id: inputs.run_id, event, payload });

    return { outputs: { ok: true } };
  },
);
