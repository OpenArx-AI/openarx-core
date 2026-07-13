// ── Outcome taxonomy (runtime §6) ────────────────────────────────────────────
//
// RUNTIME-level outcomes, NOT business outcomes. Business verdicts (VERIFIED /
// annotate / reject-publication …) are formed by the methodology from primitive
// `outputs`, never here.
//
//   ok       — primitive ran, result in `outputs`.
//   returned — a valid business "no" the primitive itself signals (e.g.
//              check-stop-rule: GO not found). A NORMAL output, not an error.
//   failed   — technical error (model down, timeout, bug). Retried where allowed.
//   rejected — contract violation (unknown version, access-violation, grossly
//              unreadable primitive output). Not retried; escalated to caller.

export type OutcomeStatus = 'ok' | 'returned' | 'failed' | 'rejected';

export type Outcome<T> =
  | { readonly status: 'ok'; readonly outputs: T }
  | { readonly status: 'returned'; readonly outputs: T }
  | { readonly status: 'failed'; readonly error: RuntimeError }
  | { readonly status: 'rejected'; readonly error: RuntimeError };

/** Business control a primitive returns alongside its outputs. Defaults to 'ok'. */
export type Control = 'ok' | 'returned';

export interface PrimitiveResult<Out> {
  /** 'returned' marks a valid business "no"; omit or 'ok' for the normal path. */
  readonly control?: Control;
  readonly outputs: Out;
}

export type RuntimeErrorCode =
  | 'unknown-primitive'
  | 'unknown-version'
  | 'access-violation'
  | 'bad-output'
  | 'immutable-store'
  | 'timeout'
  | 'model-error'
  | 'internal';

/** Whether a code is a contract violation (rejected) or a technical fault (failed). */
export const REJECTED_CODES: ReadonlySet<RuntimeErrorCode> = new Set<RuntimeErrorCode>([
  'unknown-primitive',
  'unknown-version',
  'access-violation',
  'bad-output',
  'immutable-store',
]);

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
  /** Maps to the §6 outcome bucket. */
  get outcome(): 'failed' | 'rejected' {
    return REJECTED_CODES.has(this.code) ? 'rejected' : 'failed';
  }
}

/** Raised by the ctx when a primitive reaches beyond its declared access/effects. */
export class AccessViolation extends RuntimeError {
  constructor(message: string) {
    super('access-violation', message);
    this.name = 'AccessViolation';
  }
}

/** Raised by append-only handles on update/delete attempts. */
export class ImmutableStoreError extends RuntimeError {
  constructor(message: string) {
    super('immutable-store', message);
    this.name = 'ImmutableStoreError';
  }
}
