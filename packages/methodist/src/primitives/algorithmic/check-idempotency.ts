// ── check-idempotency v1 (algorithmic · deterministic) ───────────────────────
//
// goal: has this submission (by hash) already been judged at this run+stage?
// in: { run_id, stage?, submission_hash, scope? } · out: { hit, outcome?, prior? }
//   · access: hash-index · effects: none.
// 2g / openarx-bass: the key is (run_id, stage, submission_hash), so an identical re-submit
// at the same stage — GO **or RETURN** — short-circuits to the STORED outcome BEFORE call-
// model (no re-run → no "roll the submission until a random GO"). The result is an ok fact;
// the methodology gates on $idem.hit and replays $idem.outcome.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  submission_hash: string;
  /** scope key — the methodology passes the run_id (per-run idempotency). */
  scope?: string;
  run_id?: string;
  /** 2g: the judged stage — part of the key so a re-judge is idempotent per stage. */
  stage?: number | string;
}
interface Out {
  hit: boolean;
  /** the stored replayable outcome: { verdict:'GO'|'RETURN', ref?, reasons?, corrections? }. */
  outcome?: unknown;
  /** back-compat: the prior published ref (GO). Kept so pre-2g routes still resolve. */
  prior?: string;
}

export const checkIdempotencyPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'check-idempotency',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'detect an already-processed submission by content hash',
    access: ['hash-index'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const scope = inputs.scope ?? inputs.run_id;
    // 2g: (run_id, stage, submission_hash). The writer (door handler) keys GO+RETURN the same
    // way, so a re-judge at the same stage hits regardless of verdict.
    const key =
      scope != null && scope !== ''
        ? inputs.stage != null
          ? `${scope}:${inputs.stage}:${inputs.submission_hash}`
          : `${scope}:${inputs.submission_hash}`
        : inputs.submission_hash;
    const stored = await ctx.read('hash-index').get(key);
    if (stored == null) return { outputs: { hit: false } };
    // A legacy string ref (pre-049 GO record) normalizes to a GO outcome; an object is the
    // stored outcome ({verdict, ref?, reasons?, corrections?}).
    if (typeof stored === 'string') {
      return stored.length > 0 ? { outputs: { hit: true, outcome: { verdict: 'GO', ref: stored }, prior: stored } } : { outputs: { hit: false } };
    }
    const outcome = stored as Record<string, unknown>;
    const prior = typeof outcome.ref === 'string' ? outcome.ref : undefined;
    return { outputs: { hit: true, outcome, prior } };
  },
);
