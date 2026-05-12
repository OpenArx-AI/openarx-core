/**
 * migrate-coverage-map — rebuild coverage_map per-category granularity.
 *
 * Reads `documents` per day, computes per-category counters and breakdowns,
 * inserts into a new table `coverage_map_new`. The original `coverage_map`
 * is NOT touched — final swap is a separate, manual step done after the
 * runner code is updated to write per-cat rows.
 *
 * Safe to run online: only INSERT into coverage_map_new (a table that no
 * runtime code path reads or writes). Idempotent via ON CONFLICT DO NOTHING.
 *
 * Per-doc rule: a paper with categories=[cs.AI, cs.LG] increments BOTH
 * cs.AI and cs.LG counters. Sum of `actual` across cats > unique paper
 * count, but per-cat numbers are correct.
 *
 * Usage:
 *   migrate-coverage-map --create-table     # CREATE TABLE coverage_map_new (LIKE coverage_map INCLUDING ALL)
 *   migrate-coverage-map --drop-table       # DROP TABLE coverage_map_new
 *   migrate-coverage-map --reset            # TRUNCATE coverage_map_new (re-test)
 *   migrate-coverage-map --day YYYY-MM-DD   # one date (test mode)
 *   migrate-coverage-map --from FROM --to TO  # date range
 *   migrate-coverage-map --all              # full coverage_map period (min..max)
 *   migrate-coverage-map --dry-run          # compute totals without writing
 *
 * Soft-deleted documents are INCLUDED (per spec: counted as covered).
 * indexing_tier=NULL becomes 'unknown' bucket — separate doctor task
 * (openarx-rfsj) backfills missing tiers BEFORE this migration is final.
 */

import { pool, query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('migrate-coverage-map');

interface DocRow {
  status: string;
  categories: string[] | null;
  license: string | null;
  indexing_tier: string | null;
}

interface CatStats {
  actual: number;          // status='ready'
  dlFailed: number;        // status='download_failed'
  skipped: number;         // status='skipped'
  licenses: Record<string, number>;   // license → count among ready docs
  processing: Record<string, number>; // indexing_tier → count among ready docs
}

interface DayStats {
  cats: number;
  ready: number;
  dlFailed: number;
  skipped: number;
  totalDocs: number;
}

interface Args {
  createTable: boolean;
  dropTable: boolean;
  reset: boolean;
  day?: string;
  from?: string;
  to?: string;
  all: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const result: Args = {
    createTable: argv.includes('--create-table'),
    dropTable: argv.includes('--drop-table'),
    reset: argv.includes('--reset'),
    all: argv.includes('--all'),
    dryRun: argv.includes('--dry-run'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--day') result.day = argv[i + 1];
    if (argv[i] === '--from') result.from = argv[i + 1];
    if (argv[i] === '--to') result.to = argv[i + 1];
  }
  return result;
}

async function createTable(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS coverage_map_new (LIKE coverage_map INCLUDING ALL)`);
  const r = await query<{ count: string }>(`SELECT count(*)::text AS count FROM coverage_map_new`);
  log.info({ rows: r.rows[0]?.count ?? '0' }, 'coverage_map_new ready');
}

async function dropTable(): Promise<void> {
  await query(`DROP TABLE IF EXISTS coverage_map_new`);
  log.info('coverage_map_new dropped');
}

async function resetTable(): Promise<void> {
  await query(`TRUNCATE coverage_map_new`);
  log.info('coverage_map_new truncated');
}

async function migrateDay(date: string, dryRun: boolean): Promise<DayStats> {
  const docs = await query<DocRow>(
    `SELECT status, categories, license, indexing_tier
     FROM documents
     WHERE source = 'arxiv' AND published_at::date = $1::date`,
    [date],
  );

  const stats = new Map<string, CatStats>();
  for (const doc of docs.rows) {
    const cats = doc.categories ?? [];
    for (const cat of cats) {
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
        default:
          // pending / parsing / chunking / embedding / failed — ignored for coverage
          break;
      }
    }
  }

  const summary: DayStats = {
    cats: stats.size,
    ready: 0,
    dlFailed: 0,
    skipped: 0,
    totalDocs: docs.rows.length,
  };

  for (const [, s] of stats) {
    summary.ready += s.actual;
    summary.dlFailed += s.dlFailed;
    summary.skipped += s.skipped;
  }

  if (dryRun || stats.size === 0) return summary;

  for (const [cat, s] of stats) {
    const status = s.actual > 0 ? 'partial' : 'expected_unknown';
    const breakdown = { licenses: s.licenses, processing: s.processing };
    await query(
      `INSERT INTO coverage_map_new
         (source, category, date, expected, actual, download_failed, skipped, status, breakdown, last_checked_at)
       VALUES ('arxiv', $1, $2::date, NULL, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (source, category, date) DO NOTHING`,
      [cat, date, s.actual, s.dlFailed, s.skipped, status, JSON.stringify(breakdown)],
    );
  }
  return summary;
}

async function getDateRangeFromCoverage(): Promise<{ min: string; max: string }> {
  const r = await query<{ min: string; max: string }>(
    `SELECT min(date)::text AS min, max(date)::text AS max FROM coverage_map`,
  );
  if (!r.rows[0]?.min || !r.rows[0]?.max) {
    throw new Error('coverage_map is empty — cannot derive --all range');
  }
  return r.rows[0];
}

function buildDateList(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`invalid date range: ${from}..${to}`);
  }
  const dates: string[] = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.dropTable) {
    await dropTable();
    return;
  }
  if (args.createTable) {
    await createTable();
    return;
  }
  if (args.reset) {
    await resetTable();
    return;
  }

  let dates: string[];
  if (args.day) {
    dates = [args.day];
  } else if (args.from && args.to) {
    dates = buildDateList(args.from, args.to);
  } else if (args.all) {
    const range = await getDateRangeFromCoverage();
    log.info({ min: range.min, max: range.max }, 'using coverage_map full range');
    dates = buildDateList(range.min, range.max);
  } else {
    console.error(
      'usage: migrate-coverage-map [--create-table | --drop-table | --reset]\n' +
      '                            [--day YYYY-MM-DD | --from F --to T | --all] [--dry-run]',
    );
    process.exit(1);
  }

  log.info({ days: dates.length, first: dates[0], last: dates[dates.length - 1], dryRun: args.dryRun }, 'starting migration');
  const t0 = Date.now();
  const totals = { cats: 0, ready: 0, dlFailed: 0, skipped: 0, days: 0, daysWithData: 0 };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    try {
      const r = await migrateDay(date, args.dryRun);
      totals.cats += r.cats;
      totals.ready += r.ready;
      totals.dlFailed += r.dlFailed;
      totals.skipped += r.skipped;
      totals.days++;
      if (r.totalDocs > 0) totals.daysWithData++;
    } catch (err) {
      log.error({ date, err: err instanceof Error ? err.message : String(err) }, 'day migration failed');
    }
    if ((i + 1) % 100 === 0 || i === dates.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (i + 1) / Math.max(elapsed, 0.001);
      log.info(
        {
          progress: `${i + 1}/${dates.length}`,
          daysWithData: totals.daysWithData,
          totalCatsInserted: totals.cats,
          ready: totals.ready,
          downloadFailed: totals.dlFailed,
          skipped: totals.skipped,
          rate: `${rate.toFixed(1)} days/s`,
        },
        'progress',
      );
    }
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  log.info({ ...totals, elapsedSec }, 'migration complete');
  await pool.end();
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'migration script failed');
  process.exit(1);
});
