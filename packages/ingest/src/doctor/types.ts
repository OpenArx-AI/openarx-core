/**
 * Doctor framework types — modular data integrity checks.
 */

import type { ModelRouter } from '@openarx/types';
import type { EmbedClient } from '@openarx/api';

export interface DoctorContext {
  qdrantUrl: string;
  qdrantApiKey?: string;
  fix: boolean;
  fixLimit?: number; // Max records to fix per check (undefined = unlimited)
  /** Required only by checks that issue LLM calls (.complete) — embedding
   *  reindexes use embedClient instead. Optional so plain detect() runs
   *  without needing services up. */
  modelRouter?: ModelRouter;
  /** Required by checks that re-embed chunks (flat-section-paths,
   *  missing-qdrant-chunks). Same client used by ingest pipeline so all
   *  embedding writes share Redis cache + rate-limiter. */
  embedClient?: EmbedClient;
}

export interface CheckResult {
  status: 'ok' | 'warn' | 'error';
  message: string;
  affectedCount: number;
  details?: unknown;
}

export interface FixResult {
  fixed: number;
  failed: number;
  message: string;
}

export interface CheckModule {
  name: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  detect(): Promise<CheckResult>;
  fix?(): Promise<FixResult>;
}

export interface DoctorReport {
  checksRun: number;
  ok: number;
  warnings: number;
  errors: number;
  results: Array<{
    name: string;
    severity: string;
    result: CheckResult;
    fixResult?: FixResult;
  }>;
}
