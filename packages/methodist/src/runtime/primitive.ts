// ── Primitive implementation contract (framework §1, runtime §2) ─────────────
//
// A primitive receives already-resolved `inputs` (the interpreter resolves them
// from blackboard slots — NOT the runtime's concern), `params` from the
// methodology, a `ctx` gating persistent access, and — for model-call kind only
// — an injected `model` client. It returns a PrimitiveResult (outputs + optional
// business control). It NEVER validates cross-primitive schemas (framework §1).

import type { Ctx } from './context.js';
import type { ModelClient } from './model-client.js';
import type { Passport } from './passport.js';
import type { PrimitiveResult } from './outcomes.js';

export interface PrimitiveArgs {
  /** methodology-supplied configuration (prompt/model/mode/overlay/…) */
  readonly params: unknown;
  /** already-resolved blackboard inputs */
  readonly inputs: unknown;
  /** access door for declared persistent stores */
  readonly ctx: Ctx;
  /** injected model client — present iff passport.kind === 'model-call' */
  readonly model?: ModelClient;
}

export type PrimitiveImpl = (
  args: PrimitiveArgs,
) => Promise<PrimitiveResult<unknown>> | PrimitiveResult<unknown>;

export interface Registration {
  readonly passport: Passport;
  readonly impl: PrimitiveImpl;
}

/** Helper for authoring a typed primitive while keeping the registry generic. */
export function definePrimitive<Params, In, Out>(
  passport: Passport,
  impl: (args: {
    params: Params;
    inputs: In;
    ctx: Ctx;
    model?: ModelClient;
  }) => Promise<PrimitiveResult<Out>> | PrimitiveResult<Out>,
): Registration {
  return { passport, impl: impl as PrimitiveImpl };
}
