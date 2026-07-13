// ── derive-run-status v1 (algorithmic · deterministic · read-view) ───────────
//
// §12.1-bis: run.status is NOT stored — it is DERIVED from the run's path-events
// (by ts), never from the `current_stage` cache (deriving from the cache would
// return exactly the drift §12.1 exists to remove). in: { path_events?, cycle?, now? }
// · params: { final_stage_by_cycle, abandon_threshold_ms? } · access: none · effects: none.
//
// Rules (in order):
//   done     = ∃ a `checkpoint_go` event whose stage == final_stage_by_cycle[cycle]
//              (methodist value; if the cycle has no final_stage, DON'T conclude
//               done-by-final — fall through).
//   paused   = the LAST path-event is `report_need`.
//   abandoned= not-done ∧ not-paused ∧ (now − last_event_ts > abandon_threshold).
//   active   = otherwise. Resume needs no door — a new path-event re-derives to active.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface PathEvent {
  type: string;
  stage?: number;
  ts?: string;
}
interface Params {
  final_stage_by_cycle?: Record<string, number>;
  abandon_threshold_ms?: number;
}
interface In {
  path_events?: PathEvent[];
  cycle?: string;
  now?: string;
}
interface Out {
  status: 'done' | 'paused' | 'abandoned' | 'active';
  reason?: string;
}

const DEFAULT_ABANDON_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const deriveRunStatusPrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'derive-run-status',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'derive run status (done|paused|abandoned|active) from the path-events, never from the current_stage cache (§12.1)',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => {
    const p = (params ?? {}) as Params;
    const events = [...(inputs.path_events ?? [])].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));

    // done — a checkpoint_go at this cycle's final stage (only if the cycle has a final_stage).
    const finalStage = inputs.cycle != null ? p.final_stage_by_cycle?.[inputs.cycle] : undefined;
    if (typeof finalStage === 'number' && events.some((e) => e.type === 'checkpoint_go' && e.stage === finalStage)) {
      return { outputs: { status: 'done', reason: 'checkpoint_go@final_stage' } };
    }

    // paused — the last path-event is a report_need.
    const last = events[events.length - 1];
    if (last && last.type === 'report_need') {
      return { outputs: { status: 'paused', reason: 'last_event=report_need' } };
    }

    // abandoned — stale (only when `now` and a last-event ts are available).
    const threshold = typeof p.abandon_threshold_ms === 'number' ? p.abandon_threshold_ms : DEFAULT_ABANDON_MS;
    if (last?.ts && inputs.now) {
      const age = Date.parse(inputs.now) - Date.parse(last.ts);
      if (Number.isFinite(age) && age > threshold) {
        return { outputs: { status: 'abandoned', reason: 'stale' } };
      }
    }

    return { outputs: { status: 'active' } };
  },
);
