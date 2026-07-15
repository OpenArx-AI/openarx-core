// ── fetch-run-closeout v1 (retrieval · deterministic) ────────────────────────
//
// goal: §12.1 finalization presence-check — "is this run finalized?" A run is
// finalized IFF a non-superseded `version_closeout` activity exists for it (a durable
// append-only marker the methodology emits on the closeout-checkpoint GO). This is the
// single durable done-signal: run.status is uniformly 'active' on the node and never
// advances (§12.1-bis derives, never stores), so done cannot be read off the run.
// in: { run_id } · out: { finalized: boolean } · access: activities · effects: none.
//
// The `version_closeout` activity_type is an indexed Neo4j scalar, so the store scans
// only the handful of closeout activities; run_id + is_superseded live in `_data` and are
// filtered here. Real and back-filled (`backfilled:true`) closeouts count identically —
// presence is the signal (the flag is for methodist analytics, not derivation).

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  run_id: string;
}
interface Out {
  finalized: boolean;
}
interface CloseoutRecord {
  run_id?: unknown;
  is_superseded?: unknown;
}

export const fetchRunCloseoutPrimitive: Registration = definePrimitive<
  Record<string, never>,
  In,
  Out
>(
  {
    id: 'fetch-run-closeout',
    version: 'v1',
    kind: 'retrieval',
    goal: 'presence-check a run’s durable version_closeout marker (§12.1 finalization) → finalized:boolean',
    access: ['activities'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const acts = (await ctx
      .read('activities')
      .list({ activity_type: 'version_closeout' })) as CloseoutRecord[];
    const finalized = acts.some((a) => a?.run_id === inputs.run_id && a?.is_superseded !== true);
    return { outputs: { finalized } };
  },
);
