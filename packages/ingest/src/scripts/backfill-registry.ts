#!/usr/bin/env node
/**
 * Registry backfill — per-document coverage registry for PAST dates
 * (openarx-mu5a, epic openarx-tvts).
 *
 * Scans arXiv listings (Atom feed, whole-arxiv day windows — same source
 * the ingest runner uses) over a date interval and registers every paper
 * not yet known in our DB as a status='listed' row: metadata only, no
 * downloads, no LLM. After this, `doctor --check registry-gaps` sees the
 * real historical gaps and Console coverage becomes truthful for the past.
 *
 * Safe by construction: inserts are idempotent (NOT EXISTS over any
 * version + ON CONFLICT DO NOTHING), existing/soft-deleted documents are
 * never touched. Re-running any interval is harmless.
 *
 * Usage:
 *   node dist/scripts/backfill-registry.js --dateFrom 2025-01-01 --dateTo 2025-03-31 [--dry-run] [--force] [--ignore-runner]
 *
 *   --dateFrom/--dateTo  inclusive interval, YYYY-MM-DD
 *   --dry-run            fetch listings + report would-insert counts, write nothing
 *   --force              re-process days already marked done in the progress log
 *   --ignore-runner      skip the runner-idle check (NOT recommended: shared
 *                        arXiv rate limit — concurrent fetching risks 429s)
 *
 * Resumability: progress is appended per-day to
 * $RUNNER_DATA_DIR/registry-backfill-progress.jsonl. Completed days are
 * skipped on restart (unless --force). Interrupt (Ctrl-C/SIGTERM) finishes
 * the current day, writes its progress line, then exits.
 *
 * Rate: arXiv ~3s/request (enforced inside ArxivSource), a day is ~7-8
 * requests → ~25-30s/day → ~3 hours per year of range.
 *
 * Limits: new-format arXiv IDs only (YYMM.NNNNN, 2007-04+). Older IDs are
 * skipped with a warning — do not run for dates before 2007-04 without
 * extending the entry parser.
 */

import { join } from 'node:path';
import { appendFile, readFile } from 'node:fs/promises';
import { query, pool } from '@openarx/api';
import { ArxivSource } from '../sources/arxiv-source.js';
import type { ArxivEntry } from '../sources/arxiv-source.js';
import { buildListedRows, buildListedInsertSql, flattenListedRows } from '../lib/listed-registry.js';
import { sendCommand } from '../runner/RunnerSocket.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('backfill-registry');

const DATA_DIR = process.env.RUNNER_DATA_DIR ?? join(process.cwd(), 'data/samples/arxiv');
const SOCKET_PATH = process.env.RUNNER_SOCKET ?? '/run/openarx/runner.sock';
const PROGRESS_FILE = join(DATA_DIR, 'registry-backfill-progress.jsonl');
const BATCH_SIZE = 200;
const BATCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];
const NEW_ID_RE = /^\d{4}\.\d{4,5}$/;

interface DayProgress {
  day: string; // YYYY-MM-DD
  total: number; // arXiv totalResults at scan time
  fetched: number; // entries actually paginated
  inserted: number; // new listed rows written
  skippedOldId: number; // pre-2007 / unparseable ids skipped
  collisions: number; // papers skipped: oarx_id taken by a different paper
  dryRun: boolean;
  ts: string;
}

interface Args {
  dateFrom: string;
  dateTo: string;
  dryRun: boolean;
  force: boolean;
  ignoreRunner: boolean;
}

function parseArgs(argv: string[]): Args {
  let dateFrom: string | undefined;
  let dateTo: string | undefined;
  let dryRun = false;
  let force = false;
  let ignoreRunner = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dateFrom' && argv[i + 1]) { dateFrom = argv[++i]; }
    else if (argv[i] === '--dateTo' && argv[i + 1]) { dateTo = argv[++i]; }
    else if (argv[i] === '--dry-run') { dryRun = true; }
    else if (argv[i] === '--force') { force = true; }
    else if (argv[i] === '--ignore-runner') { ignoreRunner = true; }
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateFrom || !dateTo || !DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    console.error('Usage: backfill-registry --dateFrom YYYY-MM-DD --dateTo YYYY-MM-DD [--dry-run] [--force] [--ignore-runner]');
    process.exit(1);
  }
  if (dateFrom > dateTo) {
    console.error(`--dateFrom (${dateFrom}) must be <= --dateTo (${dateTo})`);
    process.exit(1);
  }
  if (dateFrom < '2007-04-01') {
    console.error('Dates before 2007-04 are not supported: old-format arXiv IDs (e.g. cond-mat/0501234) are not parsed by the entry parser.');
    process.exit(1);
  }
  return { dateFrom, dateTo, dryRun, force, ignoreRunner };
}

/** Inclusive list of YYYY-MM-DD days, ascending. */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d.getTime() <= end.getTime()) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

async function loadCompletedDays(): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    const content = await readFile(PROGRESS_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as DayProgress;
        // Dry-run lines don't count as done; partial days (fetched < total)
        // do count — totals drift on arXiv, re-running is the operator's
        // call via --force.
        if (!p.dryRun && p.day) done.add(p.day);
      } catch { /* tolerate corrupt lines */ }
    }
  } catch { /* no progress file yet */ }
  return done;
}

async function assertRunnerIdle(ignore: boolean): Promise<void> {
  if (ignore) return;
  try {
    const resp = await sendCommand(SOCKET_PATH, { type: 'status' });
    const state = (resp.data as { state?: string } | undefined)?.state;
    if (state && state !== 'idle') {
      console.error(`Runner is ${state} — concurrent arXiv fetching shares the rate limit and risks 429s. Wait for idle or pass --ignore-runner.`);
      process.exit(1);
    }
  } catch {
    log.warn({ socket: SOCKET_PATH }, 'Runner socket not reachable — assuming no runner on this host, proceeding');
  }
}

/** Filter out entries whose id did not parse to the new arXiv format. */
function splitParseable(entries: ArxivEntry[]): { ok: ArxivEntry[]; badIds: string[] } {
  const ok: ArxivEntry[] = [];
  const badIds: string[] = [];
  for (const e of entries) {
    if (NEW_ID_RE.test(e.arxivId)) ok.push(e);
    else badIds.push(e.arxivId);
  }
  return { ok, badIds };
}

async function fetchBatchWithRetry(
  source: ArxivSource,
  dayCompact: string,
  offset: number,
): Promise<{ total: number; entries: ArxivEntry[] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < BATCH_RETRIES; attempt++) {
    try {
      return await source.searchByDateWindow(dayCompact, offset, BATCH_SIZE);
    } catch (err) {
      lastErr = err;
      const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      log.warn({ day: dayCompact, offset, attempt: attempt + 1, err: err instanceof Error ? err.message : err, backoff }, 'batch fetch failed, retrying');
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** How many of these source_ids are already in documents (any status/version). */
async function countKnown(sourceIds: string[]): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const res = await query<{ cnt: string }>(
    `SELECT count(DISTINCT source_id)::text as cnt FROM documents WHERE source = 'arxiv' AND source_id = ANY($1)`,
    [sourceIds],
  );
  return parseInt(res.rows[0]?.cnt ?? '0', 10);
}

/**
 * oarx_id collisions: papers whose 32-bit truncated hash is already taken
 * by a DIFFERENT paper. The insert skips them (guard in listed-registry);
 * here we log the concrete pairs so they are not silently lost — these
 * papers stay out of the registry until the oarx_id scheme is resolved.
 */
async function logOarxCollisions(day: string, rows: Array<{ sourceId: string; oarxId: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await query<{ new_id: string; existing_id: string; oarx_id: string }>(
    `SELECT v.new_id, d.source_id as existing_id, d.oarx_id
     FROM unnest($1::text[], $2::text[]) AS v(new_id, oarx)
     JOIN documents d ON d.oarx_id = v.oarx
     WHERE d.source_id <> v.new_id`,
    [rows.map((r) => r.sourceId), rows.map((r) => r.oarxId)],
  );
  for (const c of res.rows) {
    log.warn({ day, newPaper: c.new_id, existingPaper: c.existing_id, oarxId: c.oarx_id },
      'oarx_id collision — paper SKIPPED from registry (32-bit hash truncation)');
  }
  return res.rows.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await assertRunnerIdle(args.ignoreRunner);

  const allDays = enumerateDays(args.dateFrom, args.dateTo);
  const completed = args.force ? new Set<string>() : await loadCompletedDays();
  const days = allDays.filter((d) => !completed.has(d));
  const skippedDone = allDays.length - days.length;

  log.info({
    dateFrom: args.dateFrom, dateTo: args.dateTo,
    days: days.length, skippedAlreadyDone: skippedDone,
    dryRun: args.dryRun, progressFile: PROGRESS_FILE,
  }, 'Registry backfill starting');

  let stopRequested = false;
  const requestStop = (): void => {
    if (stopRequested) process.exit(130); // second signal: hard exit
    stopRequested = true;
    log.warn('Stop requested — finishing current day, then exiting (repeat to force)');
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  const source = new ArxivSource({ dataDir: DATA_DIR });
  const totals = { days: 0, fetched: 0, inserted: 0, skippedOldId: 0, failedDays: [] as string[] };

  for (const day of days) {
    if (stopRequested) break;
    const dayCompact = day.replace(/-/g, '');

    try {
      const probe = await fetchBatchWithRetry(source, dayCompact, 0);
      const total = probe.total;
      let fetched = 0;
      let inserted = 0;
      let skippedOldId = 0;
      const dayHashPairs: Array<{ sourceId: string; oarxId: string }> = [];

      let offset = 0;
      let entries = probe.entries;
      while (entries.length > 0) {
        fetched += entries.length;
        const { ok, badIds } = splitParseable(entries);
        skippedOldId += badIds.length;
        if (badIds.length > 0) {
          log.warn({ day, count: badIds.length, sample: badIds.slice(0, 3) }, 'entries with unparseable ids skipped');
        }

        if (ok.length > 0) {
          const rows = buildListedRows(ok);
          dayHashPairs.push(...rows.map((r) => ({ sourceId: r.sourceId, oarxId: r.oarxId })));
          if (args.dryRun) {
            const known = await countKnown(ok.map((e) => e.arxivId));
            inserted += ok.length - known;
          } else {
            const res = await query(buildListedInsertSql(rows.length), flattenListedRows(rows));
            inserted += res.rowCount ?? 0;
          }
        }

        offset += entries.length;
        if (offset >= total || stopRequested) break;
        ({ entries } = await fetchBatchWithRetry(source, dayCompact, offset));
      }

      const collisions = await logOarxCollisions(day, dayHashPairs);

      const progress: DayProgress = {
        day, total, fetched, inserted, skippedOldId, collisions,
        dryRun: args.dryRun, ts: new Date().toISOString(),
      };
      // Interrupted mid-day → no progress line, day re-runs next time.
      if (!stopRequested || fetched >= total) {
        await appendFile(PROGRESS_FILE, JSON.stringify(progress) + '\n');
      }

      totals.days++;
      totals.fetched += fetched;
      totals.inserted += inserted;
      totals.skippedOldId += skippedOldId;
      log.info({ day, total, fetched, inserted, skippedOldId, collisions, dryRun: args.dryRun }, 'day complete');
    } catch (err) {
      totals.failedDays.push(day);
      log.error({ day, err: err instanceof Error ? err.message : err }, 'day failed after retries — continuing with next day');
    }
  }

  log.info({
    daysProcessed: totals.days,
    entriesFetched: totals.fetched,
    [args.dryRun ? 'wouldInsert' : 'listedInserted']: totals.inserted,
    skippedOldId: totals.skippedOldId,
    failedDays: totals.failedDays,
    interrupted: stopRequested,
  }, 'Registry backfill finished');

  if (totals.failedDays.length > 0) {
    log.warn({ failedDays: totals.failedDays }, 'Re-run the same interval to retry failed days (completed days are skipped via progress log)');
  }

  await pool.end();
  process.exit(totals.failedDays.length > 0 ? 2 : 0);
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : err }, 'Registry backfill crashed');
  process.exit(1);
});
