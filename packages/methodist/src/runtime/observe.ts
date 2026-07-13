// ── Observability (runtime §8) ───────────────────────────────────────────────
//
// The runtime emits one record per invocation — id, version, hash(params),
// outcome, duration, determinism — WITHOUT the content of any judgment beyond
// its schema. These facts feed the run journal and the methodology-improvement
// loop; the runtime itself stays methodology-agnostic.

import { createHash } from 'node:crypto';
import type { Determinism, PrimitiveKind } from './passport.js';
import type { OutcomeStatus } from './outcomes.js';

export interface CallRecord {
  readonly id: string;
  readonly version: string;
  readonly kind: PrimitiveKind;
  readonly determinism: Determinism;
  /** sha256 over the params (no raw content) */
  readonly paramsHash: string;
  readonly status: OutcomeStatus;
  readonly durationMs: number;
  /** attempts made (>1 only when a model-call was retried) */
  readonly attempts: number;
}

export interface Observer {
  emit(record: CallRecord): void;
}

/** Collects records in memory — used by tests and lightweight harnesses. */
export class CollectingObserver implements Observer {
  readonly records: CallRecord[] = [];
  emit(record: CallRecord): void {
    this.records.push(record);
  }
}

/** Stable-ish digest of params for the call record (JSON key order preserved). */
export function hashParams(params: unknown): string {
  return createHash('sha256').update(JSON.stringify(params ?? null), 'utf8').digest('hex');
}
