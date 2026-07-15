// ── derive-run-status v1 (algorithmic · deterministic · read-view) ───────────
//
// §12.1-bis: run.status is NOT stored — it is DERIVED, never from the `current_stage`
// cache (deriving from the cache would return exactly the drift §12.1 exists to remove).
// in: { finalized?, path_events?, cycle?, now? } · params: { abandon_threshold_ms? }
// · access: none · effects: none.
//
// Rules (in order):
//   done     = the run is FINALIZED — a non-superseded `version_closeout` activity exists
//              for it (§12.1 finalization-contract). `finalized` is supplied by the
//              `fetch-run-closeout` retrieval step (a durable graph presence-check); this
//              primitive stays pure. This REPLACES the pre-v1.8 done-rule (a checkpoint_go
//              at final_stage_by_cycle[cycle]) — a recompute against a MUTABLE process table
//              that (a) retroactively un-completed past runs whenever the table changed and
//              (b) never fired at all under the cycle-key drift 28c surfaced. done is now the
//              PRESENCE of a durable append-only marker, not a recompute. Real and back-filled
//              (`backfilled:true`) closeouts are indistinguishable here by design — presence is
//              the signal; the flag is for methodist AAR/closure analytics, not derivation.
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
  abandon_threshold_ms?: number;
}
interface In {
  // §12.1 finalization: true iff a non-superseded version_closeout exists for the run
  // (from fetch-run-closeout). Presence ⇒ done, checked FIRST.
  finalized?: boolean;
  path_events?: PathEvent[];
  // cycle is retained (optional, unused for derivation) — the pre-v1.8 done-rule keyed off it;
  // done no longer depends on the cycle, but callers may still thread it without harm.
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
    goal: 'derive run status (done|paused|abandoned|active); done = presence of a durable version_closeout (§12.1), never the current_stage cache',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => {
    const p = (params ?? {}) as Params;
    const events = [...(inputs.path_events ?? [])].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));

    // done — the run is finalized (a non-superseded version_closeout exists). Checked FIRST.
    if (inputs.finalized === true) {
      return { outputs: { status: 'done', reason: 'version_closeout' } };
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
