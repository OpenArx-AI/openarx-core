/**
 * Doctor check: registry-gaps — per-document coverage registry (openarx-tvts).
 *
 * The documents table is the full per-document map of the source: every
 * arXiv listing entry is registered as status='listed' (metadata only)
 * before download. This check reports CONCRETE coverage gaps from the
 * registry — actual source_ids, not aggregate counters:
 *
 *   - status='listed'           — known on arXiv, files never downloaded
 *   - status='download_failed'  — retries exhausted (>= MAX_DOWNLOAD_RETRIES)
 *
 * Complements (does not replace) the coverage_map-based 'coverage-gaps'
 * check: coverage_map is still written in parallel (Phase 3 decides drop).
 *
 * Fix: downloads listed docs directly — the listing metadata stored on the
 * row is enough to rebuild the download request, no listing re-fetch needed.
 * Downloaded docs become status='downloaded' and are processed by the next
 * ingest run (Step 0). Failures stay 'listed' and are retried next time.
 */

import { query, PgDocumentStore } from '@openarx/api';
import { ArxivSource } from '../../sources/arxiv-source.js';
import type { ArxivEntry } from '../../sources/arxiv-source.js';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';

const log = createChildLogger('doctor:registry-gaps');
const RATE_LIMIT_MS = 3000;
const DATA_DIR = process.env.RUNNER_DATA_DIR ?? '.';
const MAX_DOWNLOAD_RETRIES = parseInt(process.env.MAX_DOWNLOAD_RETRIES ?? '10', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ListedRow {
  id: string;
  source_id: string;
  title: string;
  abstract: string | null;
  authors: Array<{ name: string }>;
  categories: string[] | null;
  published_at: string | null;
  external_ids: Record<string, string> | null;
}

/** Rebuild the download request from listing metadata stored on the row. */
function rowToEntry(row: ListedRow): ArxivEntry {
  return {
    arxivId: row.source_id,
    title: row.title,
    authors: row.authors ?? [],
    abstract: row.abstract ?? '',
    categories: row.categories ?? [],
    publishedAt: row.published_at ?? '',
    updatedAt: row.published_at ?? '',
    pdfUrl: `https://arxiv.org/pdf/${row.source_id}`,
    doi: row.external_ids?.doi,
    journalRef: row.external_ids?.journal_ref,
  };
}

export function createRegistryGapsCheck(ctx: DoctorContext): CheckModule {
  return {
    name: 'registry-gaps',
    description: 'Per-document registry: listed-but-not-downloaded + exhausted download failures',
    severity: 'medium',

    async detect(): Promise<CheckResult> {
      const listedByDay = await query<{ day: string; cnt: string; sample: string[] }>(
        `SELECT published_at::date::text as day, count(*)::text as cnt,
                (array_agg(source_id ORDER BY source_id))[1:5] as sample
         FROM documents
         WHERE source = 'arxiv' AND status = 'listed' AND deleted_at IS NULL
         GROUP BY 1 ORDER BY 1 DESC`,
      );

      const exhaustedFailed = await query<{ cnt: string; sample: string[] }>(
        `SELECT count(*)::text as cnt,
                (array_agg(source_id ORDER BY published_at DESC))[1:10] as sample
         FROM documents
         WHERE source = 'arxiv' AND status = 'download_failed'
           AND retry_count >= $1 AND deleted_at IS NULL`,
        [MAX_DOWNLOAD_RETRIES],
      );

      const listedTotal = listedByDay.rows.reduce((sum, r) => sum + parseInt(r.cnt, 10), 0);
      const failedTotal = parseInt(exhaustedFailed.rows[0]?.cnt ?? '0', 10);

      if (listedTotal === 0 && failedTotal === 0) {
        return {
          status: 'ok',
          message: 'Registry has no pending documents: every listed paper is downloaded, no exhausted failures',
          affectedCount: 0,
        };
      }

      const dayStrs = listedByDay.rows
        .slice(0, 10)
        .map((r) => `${r.day}: ${r.cnt}`);

      return {
        status: 'warn',
        message: `${listedTotal} listed-not-downloaded across ${listedByDay.rows.length} days` +
          (failedTotal > 0 ? `, ${failedTotal} download_failed with retries exhausted` : '') +
          (dayStrs.length > 0 ? ` (${dayStrs.join('; ')}${listedByDay.rows.length > 10 ? '; …' : ''})` : ''),
        affectedCount: listedTotal + failedTotal,
        details: {
          listedTotal,
          listedDays: listedByDay.rows.map((r) => ({
            day: r.day,
            count: parseInt(r.cnt, 10),
            sampleSourceIds: r.sample,
          })),
          exhaustedDownloadFailed: {
            count: failedTotal,
            retryThreshold: MAX_DOWNLOAD_RETRIES,
            sampleSourceIds: exhaustedFailed.rows[0]?.sample ?? [],
          },
        },
      };
    },

    async fix(): Promise<FixResult> {
      const limit = ctx.fixLimit ?? 100;
      const rows = await query<ListedRow>(
        `SELECT id, source_id, title, abstract, authors, categories,
                published_at::text, external_ids
         FROM documents
         WHERE source = 'arxiv' AND status = 'listed' AND deleted_at IS NULL
         ORDER BY published_at ASC
         LIMIT $1`,
        [limit],
      );

      if (rows.rows.length === 0) {
        return { fixed: 0, failed: 0, message: 'No listed documents to download' };
      }

      const documentStore = new PgDocumentStore();
      const arxivSource = new ArxivSource({ dataDir: DATA_DIR });

      let fixed = 0;
      let failed = 0;
      for (const row of rows.rows) {
        if (ctx.shouldStop?.()) {
          log.warn({ fixed, remaining: rows.rows.length - fixed - failed }, 'registry-gaps fix stopped by operator');
          break;
        }
        try {
          // Full document fetched so the download applies as a
          // read-modify-write partial update onto the SAME row.
          const doc = await documentStore.getById(row.id);
          if (!doc || doc.status !== 'listed' || doc.deletedAt) continue;
          await arxivSource.downloadAndRegister(rowToEntry(row), documentStore, doc);
          fixed++;
          log.info({ arxivId: row.source_id, fixed, total: rows.rows.length }, 'registry-gaps: downloaded listed doc');
        } catch (err) {
          // Stays 'listed' — picked up by the next fix run or ingest.
          failed++;
          log.warn({ arxivId: row.source_id, err: err instanceof Error ? err.message : err }, 'registry-gaps: download failed, row stays listed');
        }
        await sleep(RATE_LIMIT_MS);
      }

      return {
        fixed,
        failed,
        message: `Downloaded ${fixed}/${rows.rows.length} listed docs (now status='downloaded', processed by next ingest run)` +
          (failed > 0 ? `; ${failed} failed, left as 'listed'` : ''),
      };
    },
  };
}
