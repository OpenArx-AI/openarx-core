// ── Invocation (runtime §2, §6) ──────────────────────────────────────────────
//
// The single entry point: resolve (id, version) → build the gated ctx → run the
// primitive → map to an §6 outcome → emit an observation. model-call primitives
// get the injected client plus timeout+retry on technical faults; deterministic
// primitives run once. The runtime never touches the blackboard — `inputs`
// arrive already resolved (framework §1).

import { buildContext } from './context.js';
import type { ModelClient } from './model-client.js';
import { RuntimeError, type Outcome, type PrimitiveResult } from './outcomes.js';
import type { Registry } from './registry.js';
import type { PrimitiveArgs } from './primitive.js';
import type { StoreProvider } from './stores.js';
import { hashParams, type CallRecord, type Observer } from './observe.js';

export interface ModelPolicy {
  /** total attempts including the first (retries technical faults only) */
  readonly attempts: number;
  readonly timeoutMs: number;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = { attempts: 2, timeoutMs: 30_000 };

export interface RuntimeDeps {
  readonly registry: Registry;
  readonly stores: StoreProvider;
  /** injected into model-call primitives */
  readonly model?: ModelClient;
  readonly observer?: Observer;
  readonly modelPolicy?: ModelPolicy;
}

export interface Call {
  readonly id: string;
  readonly version: string;
  readonly params?: unknown;
  readonly inputs?: unknown;
}

function toRuntimeError(e: unknown): RuntimeError {
  if (e instanceof RuntimeError) return e;
  return new RuntimeError('internal', e instanceof Error ? e.message : String(e));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RuntimeError('timeout', `model call exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function invoke(deps: RuntimeDeps, call: Call): Promise<Outcome<unknown>> {
  const start = Date.now();

  // Resolve — unknown id/version is a hard rejected error, no observation.
  let reg;
  try {
    reg = deps.registry.resolve(call.id, call.version);
  } catch (e) {
    return { status: 'rejected', error: toRuntimeError(e) };
  }
  const { passport, impl } = reg;

  const emit = (status: CallRecord['status'], attempts: number): void => {
    deps.observer?.emit({
      id: passport.id,
      version: passport.version,
      kind: passport.kind,
      determinism: passport.determinism,
      paramsHash: hashParams(call.params),
      status,
      durationMs: Date.now() - start,
      attempts,
    });
  };

  const ctx = buildContext(passport, deps.stores);
  const args: PrimitiveArgs = {
    params: call.params,
    inputs: call.inputs,
    ctx,
    model: passport.kind === 'model-call' ? deps.model : undefined,
  };

  if (passport.kind === 'model-call' && !deps.model) {
    const err = new RuntimeError('internal', `no model client injected for model-call '${passport.id}'`);
    emit(err.outcome, 0);
    return { status: err.outcome, error: err };
  }

  let attempts = 0;
  const runOnce = async (): Promise<PrimitiveResult<unknown>> => {
    attempts++;
    return Promise.resolve(impl(args));
  };

  try {
    let result: PrimitiveResult<unknown>;
    if (passport.kind === 'model-call') {
      const policy = deps.modelPolicy ?? DEFAULT_MODEL_POLICY;
      result = await runModelCall(runOnce, policy);
    } else {
      result = await runOnce();
    }
    const status = result.control === 'returned' ? 'returned' : 'ok';
    emit(status, attempts);
    return { status, outputs: result.outputs };
  } catch (e) {
    const err = toRuntimeError(e);
    emit(err.outcome, attempts);
    return { status: err.outcome, error: err };
  }
}

/** Run a model-call under timeout; retry technical faults, never contract ones. */
async function runModelCall(
  runOnce: () => Promise<PrimitiveResult<unknown>>,
  policy: ModelPolicy,
): Promise<PrimitiveResult<unknown>> {
  let lastError: RuntimeError | undefined;
  for (let i = 0; i < Math.max(1, policy.attempts); i++) {
    try {
      return await withTimeout(runOnce(), policy.timeoutMs);
    } catch (e) {
      const err = toRuntimeError(e);
      if (err.outcome === 'rejected') throw err; // contract violation — do not retry
      lastError = err; // technical fault — retry
    }
  }
  throw lastError ?? new RuntimeError('internal', 'model call failed with no error captured');
}
