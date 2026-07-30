/**
 * cleanup-arxiv-source-dirs — openarx-v8ia.
 *
 * One-shot batch script: for every legacy arxiv document that still has a
 * materialized `source/` directory on storagebox, verify the sibling eprint
 * archive is intact, then `rm -rf source/`. Pairs with openarx-yvkp: ingest
 * no longer persists `source/`, so this script handles the ~739K docs that
 * were ingested before that change. Total recoverable: ~4 TB.
 *
 * Per-doc pipeline:
 *   1. SELECT next doc with sources.latex.path set (cursor-paginated by id)
 *   2. stat sources.latex.path — skip if missing or empty (already cleaned)
 *   3. stat sibling eprint — skip + WARN if missing
 *   4. tar -tzf eprint — skip + WARN if listing fails or is empty
 *   5. rm -rf sources.latex.path
 *   6. Log structured result
 *
 * Idempotent: re-run after partial completion skips already-cleaned docs at
 * step 2. Safe to pause/resume.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx \
 *     src/scripts/cleanup-arxiv-source-dirs.ts \
 *     [--limit N]              # soft cap on docs processed
 *     [--batch-size N]         # SELECT batch size (default 1000)
 *     [--workers N]            # parallel workers (default 10)
 *     [--max-failures N]       # auto-halt on integrity failures (default 50)
 *     [--source-id-prefix P]   # restrict by source_id prefix (e.g. "19" for 2019 papers)
 *     [--dry-run]              # log decisions, no actual deletes
 */

import { performance } from 'node:perf_hooks';
import { stat, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { pool, query } from '@openarx/api';
import { Semaphore } from '../lib/semaphore.js';

const execFileAsync = promisify(execFile);

// ─── CLI args ────────────────────────────────────────────────────────────

interface Args {
  limit: number | null;
  batchSize: number;
  workers: number;
  maxFailures: number;
  sourceIdPrefix: string | null;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    limit: null, batchSize: 1000, workers: 10, maxFailures: 50,
    sourceIdPrefix: null, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (x === '--batch-size') a.batchSize = parseInt(argv[++i], 10);
    else if (x === '--workers') a.workers = parseInt(argv[++i], 10);
    else if (x === '--max-failures') a.maxFailures = parseInt(argv[++i], 10);
    else if (x === '--source-id-prefix') a.sourceIdPrefix = argv[++i];
    else if (x === '--dry-run') a.dryRun = true;
    else { console.error(`unknown arg: ${x}`); process.exit(1); }
  }
  return a;
}

// ─── Types + state ───────────────────────────────────────────────────────

interface DocRow {
  id: string;
  source_id: string;
  source_path: string;
}

interface SharedState {
  cursor: string | null;
  done: boolean;
  processed: number;
  cleaned: number;
  skippedAlreadyClean: number;
  skippedNoEprint: number;
  skippedCorruptedEprint: number;
  failedDelete: number;
  freedBytes: number;
  startedAt: number;
  lastProgressAt: number;
}

const PROGRESS_EVERY = 1000;

// ─── Logging ─────────────────────────────────────────────────────────────

function logJson(payload: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n');
}

function logProgress(s: SharedState): void {
  const elapsedSec = (Date.now() - s.startedAt) / 1000;
  const docsPerMin = elapsedSec > 0 ? (s.processed / elapsedSec) * 60 : 0;
  logJson({
    stage: 'progress',
    docs_processed: s.processed,
    docs_cleaned: s.cleaned,
    skipped_already_clean: s.skippedAlreadyClean,
    skipped_no_eprint: s.skippedNoEprint,
    skipped_corrupted_eprint: s.skippedCorruptedEprint,
    failed_delete: s.failedDelete,
    freed_gb: Number((s.freedBytes / 1e9).toFixed(2)),
    docs_per_min: Math.round(docsPerMin),
    elapsed_hours: Number((elapsedSec / 3600).toFixed(3)),
  });
}

// ─── Cursor coordination ────────────────────────────────────────────────

const cursorMu = new Semaphore(1);
const stateMu = new Semaphore(1);

async function fetchNextBatch(
  state: SharedState,
  args: Args,
): Promise<DocRow[]> {
  return cursorMu.withResource(async () => {
    if (state.done) return [];

    const conds: string[] = [
      `sources->'latex'->>'path' IS NOT NULL`,
      `source_format = 'latex'`,
    ];
    const params: unknown[] = [];
    if (state.cursor) {
      params.push(state.cursor);
      conds.push(`id > $${params.length}::uuid`);
    }
    if (args.sourceIdPrefix) {
      params.push(args.sourceIdPrefix + '%');
      conds.push(`source_id LIKE $${params.length}`);
    }
    params.push(args.batchSize);

    const sql = `
      SELECT id, source_id, sources->'latex'->>'path' AS source_path
      FROM documents
      WHERE ${conds.join(' AND ')}
      ORDER BY id
      LIMIT $${params.length}
    `;
    const r = await query<DocRow>(sql, params);
    if (r.rows.length === 0) {
      state.done = true;
      return [];
    }
    state.cursor = r.rows[r.rows.length - 1].id;
    return r.rows;
  });
}

// ─── Per-doc cleanup ────────────────────────────────────────────────────

type CleanResult =
  | { kind: 'cleaned'; freedBytes: number }
  | { kind: 'already_clean' }
  | { kind: 'no_eprint' }
  | { kind: 'corrupted_eprint'; err: string }
  | { kind: 'delete_failed'; err: string };

async function processDoc(row: DocRow, args: Args): Promise<CleanResult> {
  const sourceDir = row.source_path;
  const eprintPath = join(dirname(sourceDir), 'eprint');

  // Step 1: is source/ even there?
  let sourceExists = false;
  try {
    const st = await stat(sourceDir);
    if (st.isDirectory()) {
      const entries = await readdir(sourceDir);
      sourceExists = entries.length > 0;
    }
  } catch {
    sourceExists = false;
  }
  if (!sourceExists) return { kind: 'already_clean' };

  // Step 2: eprint present?
  try {
    await stat(eprintPath);
  } catch {
    return { kind: 'no_eprint' };
  }

  // Step 3: eprint integrity (tar -tzf must list >= 1 file)
  try {
    const { stdout } = await execFileAsync('tar', ['-tzf', eprintPath]);
    const lines = stdout.split('\n').filter((s) => s.trim().length > 0);
    if (lines.length === 0) {
      return { kind: 'corrupted_eprint', err: 'tar listing empty' };
    }
  } catch (err) {
    return { kind: 'corrupted_eprint', err: err instanceof Error ? err.message : String(err) };
  }

  // Step 4: compute freed bytes (du-style) before delete, then delete
  let freedBytes = 0;
  try {
    const { stdout } = await execFileAsync('du', ['-sb', sourceDir]);
    freedBytes = parseInt(stdout.split(/\s+/)[0], 10) || 0;
  } catch {
    // du failure is non-critical; we just report 0 bytes freed for this doc
  }

  if (args.dryRun) return { kind: 'cleaned', freedBytes };

  try {
    await rm(sourceDir, { recursive: true, force: true });
  } catch (err) {
    return { kind: 'delete_failed', err: err instanceof Error ? err.message : String(err) };
  }
  return { kind: 'cleaned', freedBytes };
}

// ─── Worker ─────────────────────────────────────────────────────────────

async function worker(workerId: number, state: SharedState, args: Args): Promise<void> {
  while (true) {
    if (args.limit !== null && state.processed >= args.limit) break;

    // Auto-halt on too many corrupted-eprint events
    if (state.skippedCorruptedEprint >= args.maxFailures) {
      logJson({
        stage: 'auto_halt',
        worker_id: workerId,
        reason: `corrupted_eprint count ${state.skippedCorruptedEprint} >= max_failures ${args.maxFailures}`,
      });
      break;
    }

    const rows = await fetchNextBatch(state, args);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (args.limit !== null && state.processed >= args.limit) break;
      const t0 = performance.now();
      let result: CleanResult;
      try {
        result = await processDoc(row, args);
      } catch (err) {
        result = { kind: 'delete_failed', err: err instanceof Error ? err.message : String(err) };
      }
      const durationMs = Math.round(performance.now() - t0);

      await stateMu.withResource(async () => {
        state.processed += 1;
        switch (result.kind) {
          case 'cleaned':
            state.cleaned += 1;
            state.freedBytes += result.freedBytes;
            break;
          case 'already_clean':
            state.skippedAlreadyClean += 1;
            break;
          case 'no_eprint':
            state.skippedNoEprint += 1;
            break;
          case 'corrupted_eprint':
            state.skippedCorruptedEprint += 1;
            break;
          case 'delete_failed':
            state.failedDelete += 1;
            break;
        }
      });

      // Per-event log only for noteworthy outcomes (cleaned at progress
      // boundary; problems always). Cleanups are noisy at scale — sample by
      // PROGRESS_EVERY to control log volume.
      if (result.kind === 'no_eprint' || result.kind === 'corrupted_eprint' || result.kind === 'delete_failed') {
        logJson({
          stage: 'doc_problem',
          worker_id: workerId,
          doc_id: row.id,
          source_id: row.source_id,
          source_path: row.source_path,
          outcome: result.kind,
          duration_ms: durationMs,
          ...(result.kind === 'corrupted_eprint' || result.kind === 'delete_failed' ? { err: result.err } : {}),
        });
      }

      const shouldLog = await stateMu.withResource(async () =>
        state.processed - state.lastProgressAt >= PROGRESS_EVERY,
      );
      if (shouldLog) {
        await stateMu.withResource(async () => { state.lastProgressAt = state.processed; });
        logProgress(state);
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  logJson({ stage: 'start', args });

  // Pre-flight: count candidate docs (cheap, indexed lookup).
  const countSql = `
    SELECT count(*)::text AS n
    FROM documents
    WHERE sources->'latex'->>'path' IS NOT NULL
      AND source_format = 'latex'
      ${args.sourceIdPrefix ? `AND source_id LIKE $1` : ''}
  `;
  const countParams = args.sourceIdPrefix ? [args.sourceIdPrefix + '%'] : [];
  const c = await query<{ n: string }>(countSql, countParams);
  logJson({ stage: 'preflight', candidate_docs: parseInt(c.rows[0]?.n ?? '0', 10) });

  const state: SharedState = {
    cursor: null,
    done: false,
    processed: 0,
    cleaned: 0,
    skippedAlreadyClean: 0,
    skippedNoEprint: 0,
    skippedCorruptedEprint: 0,
    failedDelete: 0,
    freedBytes: 0,
    startedAt: Date.now(),
    lastProgressAt: 0,
  };

  const promises = Array.from({ length: args.workers }, (_, i) => worker(i + 1, state, args));
  await Promise.all(promises);

  logJson({
    stage: 'done',
    docs_processed: state.processed,
    docs_cleaned: state.cleaned,
    skipped_already_clean: state.skippedAlreadyClean,
    skipped_no_eprint: state.skippedNoEprint,
    skipped_corrupted_eprint: state.skippedCorruptedEprint,
    failed_delete: state.failedDelete,
    freed_gb: Number((state.freedBytes / 1e9).toFixed(2)),
    elapsed_hours: Number(((Date.now() - state.startedAt) / 3600_000).toFixed(3)),
  });
}

main()
  .then(async () => {
    try { await pool.end(); } catch { /* best-effort */ }
    process.exit(0);
  })
  .catch(async (err) => {
    logJson({ stage: 'fatal', error: err instanceof Error ? err.message : String(err) });
    try { await pool.end(); } catch { /* best-effort */ }
    process.exit(1);
  });
