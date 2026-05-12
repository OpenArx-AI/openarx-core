/**
 * Stuck-pending check — documents marked for re-indexing by enrichment worker
 * but not yet picked up by the main runner.
 *
 * Enrichment worker sets status='downloaded', indexing_tier=NULL when it finds
 * an open OA alternative for an abstract_only document (D6). The main runner
 * picks these up via direction='pending_only'. If they sit > 24 hours,
 * something is wrong (runner not running, or pending_only not triggered).
 *
 * Fix: informational — tells operator to run pending_only. No auto-reset.
 */

import { query } from '@openarx/api';
import type { CheckModule, CheckResult, DoctorContext, FixResult } from '../types.js';

export function createStuckPendingCheck(_ctx: DoctorContext): CheckModule {
  return {
    name: 'stuck-pending',
    description: 'Documents awaiting re-indexing after enrichment (status=downloaded, tier=NULL, >24h)',
    severity: 'low',

    async detect(): Promise<CheckResult> {
      const result = await query<{ cnt: string }>(
        `SELECT count(*)::text as cnt FROM documents
          WHERE status = 'downloaded'
            AND indexing_tier IS NULL
            AND updated_at < now() - interval '24 hours'`,
      );
      const count = parseInt(result.rows[0]?.cnt ?? '0', 10);

      if (count === 0) {
        return { status: 'ok', message: 'No stuck pending documents', affectedCount: 0 };
      }
      return {
        status: 'warn',
        message: `${count} documents waiting for re-indexing >24h — run: openarx ingest --direction pending_only`,
        affectedCount: count,
      };
    },

    async fix(): Promise<FixResult> {
      const result = await query<{ cnt: string }>(
        `SELECT count(*)::text as cnt FROM documents
          WHERE status = 'downloaded'
            AND indexing_tier IS NULL
            AND updated_at < now() - interval '24 hours'`,
      );
      const count = parseInt(result.rows[0]?.cnt ?? '0', 10);

      return {
        fixed: 0,
        failed: 0,
        message: count > 0
          ? `${count} documents pending re-indexing. Run: openarx ingest --direction pending_only`
          : 'No stuck documents',
      };
    },
  };
}
