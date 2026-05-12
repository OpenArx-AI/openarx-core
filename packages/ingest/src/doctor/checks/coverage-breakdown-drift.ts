/**
 * Coverage breakdown drift check — detects coverage_map (per-arxiv-category)
 * rows whose actual/breakdown disagree with documents.
 *
 * After the Phase 3 refactor, RunnerService re-derives coverage_map from documents
 * on every doc finish (refreshCoverageForDate), so drift should be rare. This
 * check is a periodic sanity guard — it catches drift from out-of-band writes
 * (manual SQL, third-party tools) and self-heals by refreshing affected
 * (category, date) rows from documents.
 */

import { query } from '@openarx/api';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, DoctorContext, FixResult } from '../types.js';

const log = createChildLogger('doctor:coverage-breakdown-drift');

interface DocRow {
  status: string;
  categories: string[] | null;
  license: string | null;
  indexing_tier: string | null;
}
interface CatStats {
  actual: number;
  dlFailed: number;
  skipped: number;
  licenses: Record<string, number>;
  processing: Record<string, number>;
}

async function refreshDate(dateStr: string): Promise<number> {
  const docs = await query<DocRow>(
    `SELECT status, categories, license, indexing_tier
     FROM documents
     WHERE source = 'arxiv' AND published_at::date = $1::date`,
    [dateStr],
  );
  const stats = new Map<string, CatStats>();
  for (const doc of docs.rows) {
    for (const cat of doc.categories ?? []) {
      let s = stats.get(cat);
      if (!s) {
        s = { actual: 0, dlFailed: 0, skipped: 0, licenses: {}, processing: {} };
        stats.set(cat, s);
      }
      switch (doc.status) {
        case 'ready': {
          s.actual++;
          const lic = doc.license ?? 'unknown';
          s.licenses[lic] = (s.licenses[lic] ?? 0) + 1;
          const tier = doc.indexing_tier ?? 'unknown';
          s.processing[tier] = (s.processing[tier] ?? 0) + 1;
          break;
        }
        case 'download_failed':
          s.dlFailed++;
          break;
        case 'skipped':
          s.skipped++;
          break;
      }
    }
  }
  for (const [cat, s] of stats) {
    const status = s.actual > 0 ? 'partial' : 'expected_unknown';
    const breakdown = { licenses: s.licenses, processing: s.processing };
    await query(
      `INSERT INTO coverage_map
         (source, category, date, expected, actual, download_failed, skipped, status, breakdown, last_checked_at)
       VALUES ('arxiv', $1, $2::date, NULL, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (source, category, date) DO UPDATE SET
         actual = EXCLUDED.actual,
         download_failed = EXCLUDED.download_failed,
         skipped = EXCLUDED.skipped,
         status = CASE
           WHEN coverage_map.expected IS NOT NULL AND EXCLUDED.actual >= coverage_map.expected THEN 'complete'
           ELSE EXCLUDED.status
         END,
         breakdown = EXCLUDED.breakdown,
         last_checked_at = now()`,
      [cat, dateStr, s.actual, s.dlFailed, s.skipped, status, JSON.stringify(breakdown)],
    );
  }
  return stats.size;
}

export function createCoverageBreakdownDriftCheck(_ctx: DoctorContext): CheckModule {
  return {
    name: 'coverage-breakdown-drift',
    description: 'Coverage map per-cat actual/breakdown drifted from documents',
    severity: 'low',

    async detect(): Promise<CheckResult> {
      // Per-cat per-date drift: compare coverage_map.actual against documents
      // count grouped by unnest(categories). A row is drifted when cm.actual
      // differs from the doc-derived count.
      const result = await query<{ drifted: string }>(
        `WITH doc_per_cat AS (
           SELECT unnest(d.categories) AS category,
                  d.published_at::date AS date,
                  count(*) AS doc_actual
             FROM documents d
            WHERE d.source = 'arxiv' AND d.status = 'ready'
            GROUP BY 1, 2
         )
         SELECT count(*)::text AS drifted
           FROM doc_per_cat dpc
           JOIN coverage_map cm
             ON cm.source = 'arxiv'
            AND cm.category = dpc.category
            AND cm.date = dpc.date
          WHERE cm.actual IS DISTINCT FROM dpc.doc_actual`,
      );
      const drifted = parseInt(result.rows[0]?.drifted ?? '0', 10);
      if (drifted === 0) {
        return { status: 'ok', message: 'coverage_map per-cat actual matches documents', affectedCount: 0 };
      }
      return {
        status: 'warn',
        message: `${drifted} (category, date) coverage_map rows drifted from documents`,
        affectedCount: drifted,
      };
    },

    async fix(): Promise<FixResult> {
      // Find drifted dates (any cat, any drift) and refresh each
      const dates = await query<{ pub_date: string }>(
        `WITH doc_per_cat AS (
           SELECT unnest(d.categories) AS category,
                  d.published_at::date AS date,
                  count(*) AS doc_actual
             FROM documents d
            WHERE d.source = 'arxiv' AND d.status = 'ready'
            GROUP BY 1, 2
         )
         SELECT DISTINCT dpc.date::text AS pub_date
           FROM doc_per_cat dpc
           JOIN coverage_map cm
             ON cm.source = 'arxiv'
            AND cm.category = dpc.category
            AND cm.date = dpc.date
          WHERE cm.actual IS DISTINCT FROM dpc.doc_actual
          ORDER BY pub_date`,
      );

      let refreshed = 0;
      let failed = 0;
      for (const row of dates.rows) {
        try {
          await refreshDate(row.pub_date);
          refreshed++;
        } catch (err) {
          failed++;
          log.warn({ date: row.pub_date, err: err instanceof Error ? err.message : String(err) }, 'refresh failed');
        }
      }
      log.info({ refreshed, failed, dates: dates.rows.length }, 'per-cat drift recomputed');

      return {
        fixed: refreshed,
        failed,
        message: `Refreshed ${refreshed} dates from documents (${failed} failed)`,
      };
    },
  };
}
