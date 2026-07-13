// ── route-intent v1 (algorithmic · deterministic · PRE-model) ────────────────
//
// §3.1: the single `methodist` door dispatches by intent. route-intent chooses the
// sub-procedure to run, from the current run state + the call payload, BEFORE any
// carrier call. in: { run_state?, payload? } · out: { route } · access: none · effects: none.
//
// Default semantics (§3.1; the methodist refines via params.publish_signal):
//   • no active run           → diagnose   (a run is starting)
//   • explicit publish-signal → checkpoint (deliberative hand-in / publish intent)
//   • otherwise               → ask        (mid-run guidance/consult; mode by the ask prompt)
//
// ★ publish-safety (§3.1): the publish-signal is a METHODIST VALUE (params.publish_signal).
// route-intent NEVER synthesizes it — an absent/empty spec routes to `ask`, so an
// artifact without a deliberative signal can NEVER reach checkpoint/publish.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface Signal {
  /** dotted path into the payload, e.g. "submit" or "action.kind" */
  field: string;
  /** if present: strict-equals against the payload value; else: truthy-and-present */
  equals?: unknown;
}
interface Params {
  publish_signal?: ReadonlyArray<Signal>;
  route_names?: { no_run?: string; publish?: string; else?: string };
}
interface In {
  run_state?: unknown;
  payload?: Record<string, unknown>;
}
interface Out {
  route: string;
}

function navigate(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export const routeIntentPrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'route-intent',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'choose the sub-procedure (diagnose|checkpoint|ask) for the single methodist door, pre-model',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => {
    const p = (params ?? {}) as Params;
    const names = { no_run: 'diagnose', publish: 'checkpoint', else: 'ask', ...(p.route_names ?? {}) };

    // No active run → start one (diagnose). An ACTIVE run is a run object carrying run
    // identity/state — NOT an empty `{}` (fetch-run-state's "no run" result) and NOT an
    // error slot (fetch on an absent/empty run_id, which the interpreter surfaces as
    // `{error}`). Either means "no run" → diagnose. (Regression guard, openarx-tester-279:
    // the single door fetches run-state BEFORE routing; a new agent's fetch yields `{}` or
    // an error — both must still route to diagnose, not ask. The prior `typeof === 'object'`
    // check treated those as an active run and mis-routed every new-agent intent to ask.)
    const runState = inputs.run_state;
    const RUN_FIELDS = ['run_id', 'current_stage', 'stage', 'status', 'cycle', 'dose'] as const;
    const hasActiveRun =
      runState != null &&
      typeof runState === 'object' &&
      !('error' in (runState as Record<string, unknown>)) &&
      RUN_FIELDS.some((k) => k in (runState as Record<string, unknown>));
    if (!hasActiveRun) return { outputs: { route: names.no_run } };

    // Explicit publish-signal in the payload → checkpoint. The signal spec is a methodist
    // VALUE; an absent/empty spec NEVER routes to checkpoint (publish-safety — the signal
    // is never synthesized here).
    const payload = (inputs.payload ?? {}) as Record<string, unknown>;
    const signals = p.publish_signal ?? [];
    const matched = signals.some((s) => {
      const v = navigate(payload, s.field.split('.'));
      if ('equals' in s) return v === s.equals;
      // truthy-and-present — but an empty / whitespace-only STRING is NOT a deliberative
      // signal (F1, openarx-tester-eg7): a blank submission_hash must route to `ask`, never
      // checkpoint (else a broken/empty hash reaches publish + collides on the idem key).
      if (typeof v === 'string') return v.trim() !== '';
      return v != null && v !== false;
    });
    if (matched) return { outputs: { route: names.publish } };

    // Otherwise → ask (mid-run guidance/consult; course/consult mode decided by the ask prompt).
    return { outputs: { route: names.else } };
  },
);
