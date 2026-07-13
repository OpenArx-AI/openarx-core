/**
 * RunnerService — business logic for the pipeline runner daemon.
 *
 * Handles: ingest (forward/backfill), stop, status, history.
 * Integrates arXiv fetching + document registration + PipelineOrchestrator.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PgDocumentStore,
  QdrantVectorStore,
  DefaultModelRouter,
  EmbedClient,
  computeOarxId,
  query,
  pool,
} from '@openarx/api';
import type { Document } from '@openarx/types';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { ReconciliationLoop } from './reconciliation-loop.js';
import { CoverageRefreshLoop } from './coverage-refresh-loop.js';
import { PwcLoader } from '../pipeline/enricher/pwc-loader.js';
import { ArxivSource } from '../sources/arxiv-source.js';
import type { ArxivEntry } from '../sources/arxiv-source.js';
import { createChildLogger } from '../lib/logger.js';
import {
  buildListedRows,
  buildListedInsertSql,
  flattenListedRows,
} from '../lib/listed-registry.js';
import { resolveDateBounds } from './date-bounds.js';
import { Channel } from '../pipeline/channel.js';
import { initProxyPool } from '../lib/proxy-pool.js';
import { Semaphore } from '../lib/semaphore.js';
import type { Direction, PipelineRun, StatusResult, AuditResult } from './types.js';

const log = createChildLogger('runner-service');

const DATA_DIR = process.env.RUNNER_DATA_DIR ?? join(process.cwd(), 'data/samples/arxiv');

/**
 * Burst-failure detection thresholds.
 *
 * The registry producer wraps each document download in a try/catch and
 * continues on error (runRegistryUpdate does the same per day). When the
 * underlying error source is fast (e.g. Postgres ECONNREFUSED has no I/O
 * delay), the catch+continue ripples through everything remaining in
 * milliseconds and the run finalizes as 'completed' instead of 'failed' —
 * see openarx-68f9 root cause.
 *
 * Guard: if N consecutive day-iterations fail within a short window, treat
 * this as an infrastructure-level failure, break the loop, surface the cause,
 * and finalize the run as 'failed' with metrics.auto_stop carrying the
 * specific reason and last-error message.
 */
const DAY_FAILURE_BURST_THRESHOLD = 5;
const DAY_FAILURE_BURST_WINDOW_MS = 60_000;

/**
 * Permanent (document-level) download failure — the source file is gone from
 * arXiv (withdrawn / no-pdf), retrying can never help. These docs are closed
 * as download_failed and MUST NOT feed the consecutive-failure burst counter:
 * the auto-stop guard exists for infrastructure outages (network down, arXiv
 * 5xx), and old-year day tails are dense with permanent 404s — counting them
 * false-trips the guard and kills healthy backward waves (openarx-gf2h,
 * run fba5c0e9: 150/150 errors were plain 404s).
 *
 * Message shape from arxiv-source: `Download failed: ${status} ${url}`.
 * 4xx = permanent, EXCEPT 408 (request timeout) and 429 (rate limit), which
 * are transient and must keep counting.
 */
export function isPermanentDownloadFailure(errMsg: string): boolean {
  const m = /^Download failed: (\d{3}) /.exec(errMsg);
  if (!m) return false;
  const status = Number(m[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Set by a producer when it bails out because consecutive day-failures
 * within DAY_FAILURE_BURST_WINDOW_MS exceed the threshold. Surfaced up to
 * runAllDirections so the finalize block can mark the run as failed and
 * write the cause into pipeline_runs.metrics.auto_stop.
 */
export interface InfraFailure {
  reason: string; // e.g. 'consecutive_day_failures'
  count: number; // number of consecutive failures observed
  windowMs: number; // span of the burst from first to last failure
  lastError: string; // error message from the most recent failure
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class RunnerService {
  private readonly concurrency: number;
  private readonly maxFailRate: number;
  private readonly microBatchSize: number;
  private readonly maxDownloadRetries: number;
  private readonly downloadConcurrency: number;

  private documentStore: PgDocumentStore;
  private reconciliationLoop?: ReconciliationLoop;
  private coverageRefreshLoop?: CoverageRefreshLoop;
  private vectorStore: QdrantVectorStore;
  private orchestrator!: PipelineOrchestrator;
  private arxivSource: ArxivSource;

  private currentRunId: string | null = null;
  /** Synchronous busy-claim latch (openarx-y9ef). Set the instant a run is
   *  claimed — BEFORE any await in ingest/registryUpdate/retry — so a second
   *  concurrent command can't slip through the isRunning() check while the
   *  first is still awaiting its INSERT and start a duplicate run. currentRunId
   *  takes over the lock once the row exists; on setup error the latch clears. */
  private starting = false;
  private currentStrategy: 'license_aware' | 'force_full' = 'license_aware';
  private currentBypassEmbedCache = false;
  /** Per-run categories — post-fetch processing filter. null = no filter,
   *  process every fetched paper. Set in ingest() from API/CLI param.
   *  No env-fallback by design: caller is the single source of truth. */
  private currentCategories: string[] | null = null;
  private stopRequested = false;
  private stopSignal = { requested: false };
  private abortController = new AbortController();

  constructor() {
    this.concurrency = parseInt(process.env.RUNNER_CONCURRENCY ?? '2', 10);
    this.maxFailRate = parseFloat(process.env.RUNNER_MAX_FAIL_RATE ?? '0.10');
    this.microBatchSize = parseInt(process.env.BACKFILL_MICRO_BATCH ?? '20', 10);
    this.maxDownloadRetries = parseInt(process.env.MAX_DOWNLOAD_RETRIES ?? '10', 10);
    this.downloadConcurrency = parseInt(process.env.DOWNLOAD_CONCURRENCY ?? '5', 10);

    this.documentStore = new PgDocumentStore();
    this.vectorStore = new QdrantVectorStore();
    this.arxivSource = new ArxivSource({ dataDir: DATA_DIR });
  }

  async init(): Promise<void> {
    // Qdrant payload index for `deleted` (soft-delete). Idempotent; safe
    // to call on every startup. Ensures the must_not filter in search
    // paths is cheap. See core_soft_delete_spec.md §5.
    try {
      await this.vectorStore.initDeletedPayloadIndex();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'Qdrant deleted-index init non-fatal',
      );
    }

    // Soft-delete reconciliation loop (spec §7.1). Starts timer; ticks
    // every 5 min, catches PG ↔ Qdrant drift from partial admin-API
    // failures.
    this.reconciliationLoop = new ReconciliationLoop(this.vectorStore);
    this.reconciliationLoop.start();

    // Coverage matview refresh (mv_coverage, migration 034) — drives Console's
    // fast coverage/category aggregates. Refreshes during ingest runs + idle
    // fallback. isRunning is read live so refreshes track run activity.
    this.coverageRefreshLoop = new CoverageRefreshLoop(() => this.isRunning);
    this.coverageRefreshLoop.start();

    // Crash recovery: reset documents stuck in intermediate statuses
    const stuck = await query<{ status: string; cnt: string }>(
      `SELECT status, count(*)::text as cnt FROM documents
       WHERE status IN ('parsing', 'chunking', 'enriching', 'embedding')
       GROUP BY status`,
    );
    if (stuck.rows.length > 0) {
      const details = stuck.rows.map((r) => `${r.status}: ${r.cnt}`).join(', ');
      const total = stuck.rows.reduce((s, r) => s + parseInt(r.cnt, 10), 0);
      await query(
        `UPDATE documents SET status = 'downloaded', processing_log = '[]'
         WHERE status IN ('parsing', 'chunking', 'enriching', 'embedding')`,
      );
      log.warn({ total, details }, 'Crash recovery: reset stuck documents to downloaded');
    }

    // Initialize proxy pool for arXiv API requests
    initProxyPool();

    // Build orchestrator
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!anthropicKey || !openrouterKey) {
      throw new Error('ANTHROPIC_API_KEY and OPENROUTER_API_KEY are required');
    }

    const googleAiKey = process.env.GOOGLE_AI_API_KEY;
    const modelRouter = new DefaultModelRouter({
      anthropicApiKey: anthropicKey,
      openrouterApiKey: openrouterKey,
      googleAiApiKey: googleAiKey,
    });

    const pwcPath = join(process.cwd(), 'data', 'pwc', 'papers-with-abstracts.json');
    let pwcLoader: PwcLoader | undefined;
    if (await exists(pwcPath)) {
      pwcLoader = new PwcLoader(pwcPath);
      await pwcLoader.load();
      log.info({ indexed: pwcLoader.size }, 'PwC dataset loaded');
    }

    // All Gemini + SPECTER2 embeddings go through openarx-embed-service.
    // Runner reads EMBED_SERVICE_URL from its systemd unit (drop-in) and
    // CORE_INTERNAL_SECRET from the shared .env. Both are required.
    const embedServiceUrl = process.env.EMBED_SERVICE_URL;
    const internalSecret = process.env.CORE_INTERNAL_SECRET;
    if (!embedServiceUrl || !internalSecret) {
      throw new Error('EMBED_SERVICE_URL and CORE_INTERNAL_SECRET are required');
    }
    const embedClient = new EmbedClient({ url: embedServiceUrl, secret: internalSecret });
    log.info({ url: embedServiceUrl }, 'embed-service client configured');

    this.orchestrator = new PipelineOrchestrator(
      this.documentStore,
      this.vectorStore,
      modelRouter,
      { pwcLoader, embedClient },
    );

    // Crash recovery: mark any 'running' pipeline_runs as failed
    await query(
      `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
       metrics = COALESCE(metrics, '{}'::jsonb) || '{"crash_recovery": true}'::jsonb
       WHERE status = 'running'`,
    );

    log.info({ concurrency: this.concurrency }, 'RunnerService initialized');
  }

  get isRunning(): boolean {
    return this.starting || this.currentRunId !== null;
  }

  // ─── Commands ────────────────────────────────────────────

  async ingest(
    limit: number,
    direction?: Direction,
    dateFrom?: string,
    dateTo?: string,
    strategy?: 'license_aware' | 'force_full',
    bypassEmbedCache?: boolean,
    categories?: string[],
    downloadedFirst?: boolean,
    reindexRequestedFirst?: boolean,
  ): Promise<PipelineRun> {
    if (this.isRunning) {
      throw new Error('Already running. Use "openarx status" to check progress.');
    }

    // Registry-driven model (openarx-j173): direction is the traversal order
    // over published_at. Legacy socket values are mapped, not rejected:
    //   backfill → backward, mixed → forward,
    //   pending_only → downloaded-backlog-only run (no dates needed).
    let effectiveDirection: 'forward' | 'backward' = 'forward';
    let effectiveDownloadedFirst = downloadedFirst === true;
    const effectiveReindexRequested = reindexRequestedFirst === true;
    if (direction === 'backward' || direction === 'backfill') effectiveDirection = 'backward';
    else if (direction === 'pending_only') effectiveDownloadedFirst = true;

    // reindexRequestedFirst, like downloadedFirst, operates on a backlog (demanded
    // abstract_only docs) and needs no date range.
    if (!dateFrom && !dateTo && !effectiveDownloadedFirst && !effectiveReindexRequested) {
      throw new Error(
        'At least one of dateFrom/dateTo is required (or set downloadedFirst / reindexRequestedFirst to process a backlog only).',
      );
    }

    this.stopRequested = false;
    this.stopSignal = { requested: false };
    this.abortController = new AbortController();

    // Create pipeline_run record with launch params in metrics
    const runId = randomUUID();
    const effectiveStrategy = strategy ?? 'license_aware';
    const effectiveBypassEmbedCache = bypassEmbedCache === true;
    // No env fallback: if caller didn't pass categories, currentCategories
    // stays null and the registry selection takes every category.
    const effectiveCategories =
      categories && categories.length > 0 ? categories.map((c) => c.trim()).filter(Boolean) : null;
    this.currentStrategy = effectiveStrategy;
    this.currentBypassEmbedCache = effectiveBypassEmbedCache;
    this.currentCategories = effectiveCategories;
    const runParams: Record<string, unknown> = { limit, strategy: effectiveStrategy };
    if (dateFrom) runParams.dateFrom = dateFrom;
    if (dateTo) runParams.dateTo = dateTo;
    if (effectiveDownloadedFirst) runParams.downloadedFirst = true;
    if (effectiveReindexRequested) runParams.reindexRequestedFirst = true;
    if (effectiveBypassEmbedCache) runParams.bypassEmbedCache = true;
    if (effectiveCategories) runParams.categories = effectiveCategories;
    // Claim the run synchronously before the INSERT await, so a second
    // concurrent ingest() can't pass the isRunning() guard during the INSERT
    // and start a duplicate run (openarx-y9ef).
    this.starting = true;
    try {
      await query(
        `INSERT INTO pipeline_runs (id, status, direction, source, categories, metrics)
         VALUES ($1, 'running', $2, 'arxiv', $3, $4::jsonb)`,
        [
          runId,
          effectiveDirection,
          effectiveCategories ?? [],
          JSON.stringify({ params: runParams }),
        ],
      );
      this.currentRunId = runId;
    } finally {
      this.starting = false;
    }

    log.info(
      {
        runId,
        limit,
        direction: effectiveDirection,
        dateFrom,
        dateTo,
        downloadedFirst: effectiveDownloadedFirst,
        strategy: effectiveStrategy,
        bypassEmbedCache: effectiveBypassEmbedCache,
      },
      'Ingest started',
    );

    // Run in background — don't await
    this.runIngest(
      runId,
      limit,
      effectiveDirection,
      dateFrom,
      dateTo,
      effectiveDownloadedFirst,
      effectiveReindexRequested,
    ).catch((err) => {
      log.error({ err, runId }, 'Ingest failed unexpectedly');
    });

    return this.getRunById(runId);
  }

  async registryUpdate(params: {
    dateFrom?: string;
    dateTo?: string;
    direction?: 'forward' | 'backward';
    limit?: number;
  }): Promise<PipelineRun> {
    if (this.isRunning) {
      throw new Error('Already running. Use "openarx status" to check progress.');
    }
    if (!params.dateFrom && !params.dateTo) {
      throw new Error('registry-update requires at least one of dateFrom/dateTo.');
    }

    this.stopRequested = false;
    this.stopSignal = { requested: false };
    this.abortController = new AbortController();

    const runId = randomUUID();
    const direction = params.direction ?? 'forward';
    const limit = params.limit ?? 100;
    // Synchronous busy-claim before the INSERT await (openarx-y9ef).
    this.starting = true;
    try {
      await query(
        `INSERT INTO pipeline_runs (id, status, direction, source, categories, metrics)
         VALUES ($1, 'running', 'registry_update', 'arxiv', '{}', $2::jsonb)`,
        [
          runId,
          JSON.stringify({
            params: { dateFrom: params.dateFrom, dateTo: params.dateTo, direction, limit },
          }),
        ],
      );
      this.currentRunId = runId;
    } finally {
      this.starting = false;
    }

    log.info(
      { runId, dateFrom: params.dateFrom, dateTo: params.dateTo, direction, limit },
      'Registry update started',
    );

    this.runRegistryUpdate(runId, {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      direction,
      limit,
    }).catch((err) => {
      log.error({ err, runId }, 'Registry update failed unexpectedly');
    });

    return this.getRunById(runId);
  }

  async retry(limit: number): Promise<PipelineRun> {
    if (this.isRunning) {
      throw new Error('Already running. Use "openarx status" to check progress.');
    }
    // Synchronous busy-claim before the first await (the SELECT below) — openarx-y9ef.
    this.starting = true;
    try {
      // Find retryable docs: failed/downloaded, excluding skip_retry and recent failures (3-day cooldown)
      const { rows: retryIds } = await query<{ id: string }>(
        `SELECT id FROM documents
       WHERE status IN ('failed', 'downloaded')
         AND (quality_flags->>'skip_retry' IS NULL OR quality_flags->>'skip_retry' != 'true')
         AND (
           processing_log IS NULL
           OR jsonb_array_length(processing_log) = 0
           OR (processing_log->-1->>'timestamp')::timestamptz < now() - interval '3 days'
         )
       ORDER BY random()
       LIMIT $1`,
        [limit],
      );

      const retryDocs: Document[] = [];
      for (const { id } of retryIds) {
        const doc = await this.documentStore.getById(id);
        if (doc) retryDocs.push(doc);
      }

      if (retryDocs.length === 0) {
        throw new Error('No retryable documents found (all skipped, on cooldown, or none failed).');
      }

      log.info(
        { total: retryDocs.length, skippedByFlag: 'skip_retry', cooldown: '3 days' },
        'Retry: filtered docs',
      );

      this.stopRequested = false;
      this.stopSignal = { requested: false };
      this.abortController = new AbortController();

      const runId = randomUUID();
      await query(
        `INSERT INTO pipeline_runs (id, status, direction, source, categories, docs_fetched, metrics)
       VALUES ($1, 'running', 'retry', 'arxiv', $2, $3, $4::jsonb)`,
        [runId, [], retryDocs.length, JSON.stringify({ params: { limit, retry: true } })],
      );
      this.currentRunId = runId;

      log.info({ runId, count: retryDocs.length }, 'Retry started');

      // Run in background
      this.runRetry(runId, retryDocs).catch((err) => {
        log.error({ err, runId }, 'Retry failed unexpectedly');
      });

      return this.getRunById(runId);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<StatusResult> {
    if (!this.isRunning) {
      return { state: 'idle' };
    }
    this.stopRequested = true;
    this.stopSignal.requested = true;
    this.abortController.abort();
    log.info(
      { runId: this.currentRunId },
      'Stop requested — waiting for in-flight documents to drain',
    );
    return this.status();
  }

  async status(): Promise<StatusResult> {
    if (!this.currentRunId) {
      return { state: 'idle' };
    }

    const run = await this.getRunById(this.currentRunId);
    return {
      state: 'running',
      currentRun: {
        id: run.id,
        direction: run.direction,
        docsProcessed: run.docsProcessed,
        docsFailed: run.docsFailed,
        docsSkipped: run.docsSkipped,
        startedAt: run.startedAt,
        lastProcessedId: run.lastProcessedId,
      },
    };
  }

  async history(limit: number): Promise<PipelineRun[]> {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(rowToRun);
  }

  async audit(days?: number, date?: string): Promise<AuditResult> {
    if (this.isRunning) {
      throw new Error('Cannot audit while ingest is running.');
    }

    // Get list of processed days
    let daysToCheck: string[];
    if (date) {
      daysToCheck = [date];
    } else {
      const result = await query<{ day: string }>(
        `SELECT DISTINCT TO_CHAR(published_at AT TIME ZONE 'UTC', 'YYYYMMDD') as day
         FROM documents WHERE source = 'arxiv' AND status IN ('ready', 'failed', 'downloaded')
         ORDER BY day DESC ${days ? 'LIMIT ' + days : ''}`,
      );
      daysToCheck = result.rows.map((r) => r.day);
    }

    log.info({ days: daysToCheck.length }, 'Audit: checking processed days');

    const auditResult: AuditResult = {
      daysChecked: 0,
      daysComplete: 0,
      daysWithGaps: 0,
      totalMissing: 0,
      totalDownloaded: 0,
      details: [],
    };

    for (const day of daysToCheck) {
      // Count papers in arXiv for this day (single-call probe to get total)
      const { total: arxivCount } = await this.arxivSource.searchByDateWindow(
        day,
        0,
        1,
        this.abortController.signal,
      );

      // Count papers in our DB for this day. Registry rows (status='listed')
      // are metadata-only — counting them would mask never-downloaded gaps.
      const dbResult = await query<{ cnt: string }>(
        `SELECT count(*) as cnt FROM documents
         WHERE source = 'arxiv' AND status != 'listed'
           AND published_at >= TO_TIMESTAMP($1, 'YYYYMMDD') AT TIME ZONE 'UTC'
           AND published_at < TO_TIMESTAMP($1, 'YYYYMMDD') AT TIME ZONE 'UTC' + INTERVAL '1 day'`,
        [day],
      );
      const dbCount = parseInt(dbResult.rows[0]?.cnt ?? '0', 10);

      const missing = Math.max(0, arxivCount - dbCount);
      auditResult.daysChecked++;

      if (missing === 0) {
        auditResult.daysComplete++;
        auditResult.details.push({ day, arxivCount, dbCount, missing: 0, downloaded: 0 });
        log.info({ day, arxivCount, dbCount }, 'Audit: day complete');
        continue;
      }

      // Gap found — paginate through arxiv listings for the day
      log.info({ day, arxivCount, dbCount, missing }, 'Audit: gap found, scanning');
      auditResult.daysWithGaps++;
      auditResult.totalMissing += missing;

      let downloaded = 0;
      let offset = 0;
      while (offset < arxivCount) {
        const { entries } = await this.arxivSource.searchByDateWindow(
          day,
          offset,
          200,
          this.abortController.signal,
        );
        if (entries.length === 0) break;

        // Keep the per-document registry in sync for audited days too.
        await this.registerListedEntries(entries);

        for (const entry of entries) {
          const existing = await this.documentStore.getBySourceId('arxiv', entry.arxivId);
          // Registry rows (status='listed') are still "missing" for audit
          // purposes — download files into the same row. Everything else
          // (incl. soft-deleted) is already accounted for.
          if (existing && !(existing.status === 'listed' && !existing.deletedAt)) continue;

          try {
            await this.arxivSource.downloadAndRegister(
              entry,
              this.documentStore,
              existing ?? undefined,
            );
            downloaded++;
            log.info({ arxivId: entry.arxivId, day }, 'Audit: downloaded missing paper');
          } catch (err) {
            log.error({ arxivId: entry.arxivId, err }, 'Audit: download failed');
          }
        }

        offset += entries.length;
      }

      auditResult.totalDownloaded += downloaded;
      auditResult.details.push({ day, arxivCount, dbCount, missing, downloaded });
    }

    log.info(
      {
        daysChecked: auditResult.daysChecked,
        daysWithGaps: auditResult.daysWithGaps,
        totalDownloaded: auditResult.totalDownloaded,
      },
      'Audit complete',
    );

    return auditResult;
  }

  /**
   * detect (fix=false): synchronous and read-only — safe to call any time,
   * returns a DoctorReport directly.
   *
   * fix=true: a BACKGROUND run like ingest/registry-update (openarx-76fo
   * follow-up): same busy-lock (either ingest, registry-update, or a doctor
   * fix — never two writers), tracked in pipeline_runs
   * (direction='doctor_fix'), stoppable via the `stop` command. Returns the
   * PipelineRun immediately; the report lands in metrics.report on finish.
   * An explicit check name is REQUIRED for fix: running every fix unbounded
   * was only safe on the early small corpus.
   */
  async doctor(
    fix?: boolean,
    check?: string,
    limit?: number,
  ): Promise<import('../doctor/types.js').DoctorReport | PipelineRun> {
    const { runDoctor } = await import('../doctor/runner.js');

    if (!fix) {
      const ctx: import('../doctor/types.js').DoctorContext = {
        qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6335',
        qdrantApiKey: process.env.QDRANT_API_KEY,
        fix: false,
        fixLimit: limit,
      };
      return runDoctor(ctx, { checkName: check });
    }

    if (this.isRunning) {
      throw new Error('Already running. Use "openarx status" to check progress.');
    }
    if (!check) {
      throw new Error(
        'doctor --fix requires an explicit --check <name>: running every fix at once, unbounded, is unsafe on the current corpus.',
      );
    }

    this.stopRequested = false;
    this.stopSignal = { requested: false };
    this.abortController = new AbortController();

    const runId = randomUUID();
    await query(
      `INSERT INTO pipeline_runs (id, status, direction, source, categories, metrics)
       VALUES ($1, 'running', 'doctor_fix', 'arxiv', '{}', $2::jsonb)`,
      [runId, JSON.stringify({ params: { check, limit: limit ?? null } })],
    );
    this.currentRunId = runId;

    log.info({ runId, check, limit }, 'Doctor fix started');

    this.runDoctorFix(runId, check, limit).catch((err) => {
      log.error({ err, runId }, 'Doctor fix failed unexpectedly');
    });

    return this.getRunById(runId);
  }

  private async runDoctorFix(runId: string, check: string, limit?: number): Promise<void> {
    try {
      const { runDoctor } = await import('../doctor/runner.js');
      const ctx: import('../doctor/types.js').DoctorContext = {
        qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6335',
        qdrantApiKey: process.env.QDRANT_API_KEY,
        fix: true,
        fixLimit: limit,
        modelRouter: this.orchestrator['modelRouter'],
        embedClient: this.orchestrator['config']?.embedClient,
        shouldStop: () => this.stopRequested,
      };
      const report = await runDoctor(ctx, { checkName: check });

      const fixed = report.results.reduce((s, r) => s + (r.fixResult?.fixed ?? 0), 0);
      const failed = report.results.reduce((s, r) => s + (r.fixResult?.failed ?? 0), 0);
      const finalStatus = this.stopRequested ? 'stopped' : 'completed';

      await query(
        `UPDATE pipeline_runs SET status = $1, finished_at = now(),
          docs_processed = $2, docs_failed = $3,
          metrics = COALESCE(metrics, '{}'::jsonb) || $4::jsonb
         WHERE id = $5`,
        [finalStatus, fixed, failed, JSON.stringify({ report }), runId],
      );
      log.info({ runId, status: finalStatus, check, fixed, failed }, 'Doctor fix finished');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
         metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({ error: errMsg }), runId],
      );
      log.error({ err, runId }, 'Doctor fix failed');
    } finally {
      this.currentRunId = null;
      this.stopRequested = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopRequested = true;
    await pool.end();
  }

  // ─── Internal ────────────────────────────────────────────

  /**
   * Atomically claim ONE demanded-but-abstract_only document for full re-indexing.
   * Selection: indexing_tier='abstract_only' (economically-deferred — license is a
   * PRIORITY signal, not a restriction) + status='ready' + full-content demand
   * (SUM(get_document_count)) > 1, highest demand first. The claim marks it
   * downloaded + FORCES indexing_tier='full', so the re-index is full AND the doc
   * leaves the abstract_only pool (no re-selection loop). FOR UPDATE SKIP LOCKED so
   * concurrent claimers never grab the same row. Returns the fresh Document, or null
   * when no candidate remains.
   */
  private async claimNextDemandReindexDoc(): Promise<Document | null> {
    // Lead from the small document_demand table (only requested docs) via an
    // IN-set of high-demand ids, then narrow to abstract_only/ready — ~20× cheaper
    // than scanning the ~533k abstract_only rows and evaluating demand per row.
    const r = await query<{ id: string }>(
      `UPDATE documents SET status = 'downloaded', indexing_tier = 'full'
        WHERE id = (
          SELECT d.id FROM documents d
           WHERE d.indexing_tier = 'abstract_only' AND d.status = 'ready'
             AND d.id IN (
               SELECT document_id FROM document_demand
                GROUP BY document_id HAVING SUM(get_document_count) > 1)
           ORDER BY (SELECT SUM(get_document_count)
                       FROM document_demand dd WHERE dd.document_id = d.id) DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
    );
    const id = r.rows[0]?.id;
    if (!id) return null;
    return this.documentStore.getById(id);
  }

  private async runIngest(
    runId: string,
    limit: number,
    direction: 'forward' | 'backward',
    dateFromOverride?: string,
    dateToOverride?: string,
    downloadedFirst?: boolean,
    reindexRequestedFirst?: boolean,
  ): Promise<void> {
    let remaining = limit;
    let totalFetched = 0;
    let totalProcessed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let dateFrom: Date | null = null;
    let dateTo: Date | null = null;

    // Single-date-anchor semantics: a lone date is an anchor and `direction`
    // decides which bound it fills (backward → upper, forward → lower); two
    // dates stay an explicit range. All date-scoped selection below uses these
    // resolved bounds, not the raw overrides.
    const { lower: boundFrom, upper: boundTo } = resolveDateBounds(
      dateFromOverride,
      dateToOverride,
      direction,
    );
    if (dateFromOverride || dateToOverride) {
      log.info(
        { dateFromOverride, dateToOverride, direction, boundFrom, boundTo },
        'Resolved date bounds',
      );
    }

    try {
      // Phase A (explicit --downloaded-first flag): drain the downloaded
      // backlog regardless of dates, within the limit. Replaces both the
      // old implicit Step 0 and the pending_only direction.
      if (downloadedFirst && remaining > 0 && !this.stopRequested) {
        const pending = await this.documentStore.listByStatus('downloaded', remaining);
        if (pending.length > 0) {
          log.info({ count: pending.length, remaining }, 'Processing existing downloaded papers');
          const report = await this.orchestrator.processAll(
            Math.min(pending.length, remaining),
            1,
            runId,
            this.stopSignal,
            this.currentStrategy,
            this.currentBypassEmbedCache,
          );
          for (const result of report.results) {
            if (result.status === 'ready') totalProcessed++;
            else if (result.status === 'failed') totalFailed++;
            else if (result.status === 'duplicate') totalSkipped++;
          }
          remaining -= totalProcessed + totalSkipped;

          // Get date range from processed documents
          if (report.results.length > 0) {
            const ids = report.results.filter((r) => r.status === 'ready').map((r) => r.documentId);
            if (ids.length > 0) {
              const dateResult = await query<{ min_date: Date | null; max_date: Date | null }>(
                `SELECT MIN(published_at) as min_date, MAX(published_at) as max_date FROM documents WHERE id = ANY($1::uuid[])`,
                [ids],
              );
              if (dateResult.rows[0]?.min_date)
                dateFrom = minDate(dateFrom, dateResult.rows[0].min_date);
              if (dateResult.rows[0]?.max_date)
                dateTo = maxDate(dateTo, dateResult.rows[0].max_date);
            }
          }

          log.info(
            { totalProcessed, totalFailed, remaining },
            'Existing downloaded papers processed',
          );
        }
      }

      // Demand re-index stage (reindexRequestedFirst): re-index abstract_only docs
      // that agents have REQUESTED (get_document demand > 1) to FULL. Runs AFTER the
      // downloaded_first backlog, BEFORE new-doc indexing. Documents are claimed ONE
      // at a time atomically (claimNextDemandReindexDoc marks downloaded + forces
      // indexing_tier='full') and fed into the sliding window so several process
      // concurrently — a free slot pulls the next; a full pool waits for a slot.
      if (reindexRequestedFirst && remaining > 0 && !this.stopRequested) {
        const maxConcurrentDocs = parseInt(process.env.PIPELINE_MAX_CONCURRENT_DOCS ?? '10', 10);
        const sem = new Semaphore(maxConcurrentDocs);
        const inFlight: Promise<void>[] = [];
        let reindexed = 0;
        let reindexFailed = 0;
        while (remaining > 0 && !this.stopRequested) {
          await sem.acquire();
          if (this.stopRequested || remaining <= 0) {
            sem.release();
            break;
          }
          const doc = await this.claimNextDemandReindexDoc();
          if (!doc) {
            sem.release();
            break; // no more demanded abstract_only docs
          }
          remaining -= 1;
          const p = (async () => {
            try {
              const result = await this.orchestrator.processOneDoc(
                doc,
                runId,
                this.stopSignal,
                this.currentStrategy,
                this.currentBypassEmbedCache,
              );
              if (result.status === 'ready') {
                reindexed += 1;
                totalProcessed += 1;
                log.info({ sourceId: doc.sourceId, reindexed }, 'reindexRequestedFirst: doc re-indexed to full');
              } else if (result.status === 'failed') {
                reindexFailed += 1;
                totalFailed += 1;
              }
            } finally {
              sem.release();
            }
          })();
          inFlight.push(p);
        }
        await Promise.allSettled(inFlight);
        log.info(
          { reindexed, reindexFailed, remaining },
          'reindexRequestedFirst: demand re-index stage complete',
        );
      }

      // Step 0b (force_full only): re-index existing abstract_only docs in date range.
      // When operator runs force_full, they expect ALL docs in the range to be fully indexed —
      // including those previously processed as abstract_only (restricted license).
      // The indexer is idempotent (deletes old chunks before inserting new), so re-processing is safe.
      if (this.currentStrategy === 'force_full' && remaining > 0 && !this.stopRequested) {
        const abstractOnly = await query<{ id: string }>(
          `SELECT id FROM documents
            WHERE status = 'ready' AND indexing_tier = 'abstract_only'
              AND ($1::date IS NULL OR published_at >= $1::date)
              AND ($2::date IS NULL OR published_at <= $2::date + interval '1 day')
            ORDER BY published_at DESC
            LIMIT $3`,
          [boundFrom ?? null, boundTo ?? null, remaining],
        );

        if (abstractOnly.rows.length > 0) {
          const ids = abstractOnly.rows.map((r) => r.id);
          await query(
            `UPDATE documents SET status = 'downloaded', indexing_tier = NULL
              WHERE id = ANY($1::uuid[])`,
            [ids],
          );

          log.info(
            { count: ids.length, remaining, dateFrom: dateFromOverride, dateTo: dateToOverride },
            'force_full: reset abstract_only docs for re-indexing',
          );

          const report = await this.orchestrator.processAll(
            ids.length,
            1,
            runId,
            this.stopSignal,
            this.currentStrategy,
            this.currentBypassEmbedCache,
          );

          let step0bProcessed = 0;
          let step0bFailed = 0;
          let step0bSkipped = 0;
          for (const result of report.results) {
            if (result.status === 'ready') {
              step0bProcessed++;
              totalProcessed++;
            } else if (result.status === 'failed') {
              step0bFailed++;
              totalFailed++;
            } else if (result.status === 'duplicate') {
              step0bSkipped++;
              totalSkipped++;
            }
          }
          remaining -= step0bProcessed + step0bSkipped;

          log.info(
            { step0bProcessed, step0bFailed, step0bSkipped, remaining },
            'force_full: abstract_only re-indexing complete',
          );
        }
      }

      // Track infra-failure surfaced by the registry phase — used to mark
      // the run as 'failed' in the finalize block instead of silently
      // 'completed' (openarx-68f9).
      let infraFailure: InfraFailure | undefined;

      // Registry phase — work straight from the per-document registry
      // (status IN listed/downloaded within the period), no arXiv listing
      // fetch. Stops at the limit or when the period is exhausted.
      if ((dateFromOverride || dateToOverride) && remaining > 0 && !this.stopRequested) {
        const counters = {
          remaining,
          totalFetched: 0,
          processed: 0,
          failed: 0,
          skipped: 0,
          dateFrom: null as Date | null,
          dateTo: null as Date | null,
        };
        const result = await this.processRegistryParallel(
          runId,
          { dateFrom: boundFrom, dateTo: boundTo, direction, categories: this.currentCategories },
          counters,
        );
        remaining = counters.remaining;
        totalFetched += counters.totalFetched;
        totalProcessed += counters.processed;
        // counters.failed = pipeline failures (consumer); result.failed =
        // download failures (producer) — both count as failed docs.
        totalFailed += counters.failed + result.failed;
        totalSkipped += counters.skipped;
        dateFrom = minDate(dateFrom, counters.dateFrom);
        dateTo = maxDate(dateTo, counters.dateTo);
        if (result.infraFailure) infraFailure = result.infraFailure;
      }

      // Finalize — distinguish three outcomes:
      //   stopped    — operator explicitly stopped
      //   failed     — infrastructure burst detected (consecutive day-failures)
      //   completed  — normal end (range exhausted or limit hit)
      const finalStatus = this.stopRequested ? 'stopped' : infraFailure ? 'failed' : 'completed';

      const costResult = await query<{ total: string }>(
        `SELECT COALESCE(SUM(cost) FILTER (WHERE cost = cost), 0) as total FROM processing_costs
         WHERE created_at >= (SELECT started_at FROM pipeline_runs WHERE id = $1)`,
        [runId],
      );

      // If we hit an infra burst, record the specific cause in metrics so
      // operators can see WHY the run was marked failed. Pattern matches the
      // existing fail_rate_exceeded auto_stop marker.
      const metricsUpdate = infraFailure ? JSON.stringify({ auto_stop: infraFailure }) : null;

      await query(
        `UPDATE pipeline_runs SET
          status = $1, finished_at = now(),
          date_from = $2, date_to = $3,
          docs_fetched = $4, docs_processed = $5, docs_failed = $6, docs_skipped = $7,
          total_cost = $8,
          metrics = CASE
            WHEN $9::jsonb IS NULL THEN metrics
            ELSE COALESCE(metrics, '{}'::jsonb) || $9::jsonb
          END
         WHERE id = $10`,
        [
          finalStatus,
          dateFrom,
          dateTo,
          totalFetched,
          totalProcessed,
          totalFailed,
          totalSkipped,
          parseFloat(costResult.rows[0]?.total ?? '0'),
          metricsUpdate,
          runId,
        ],
      );

      log.info(
        {
          runId,
          status: finalStatus,
          totalProcessed,
          totalFailed,
          totalSkipped,
          dateFrom: dateFrom?.toISOString(),
          dateTo: dateTo?.toISOString(),
          ...(infraFailure ? { autoStop: infraFailure } : {}),
        },
        'Ingest finished',
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
         metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb,
         docs_fetched = $2, docs_processed = $3, docs_failed = $4, docs_skipped = $5
         WHERE id = $6`,
        [
          JSON.stringify({ error: errMsg }),
          totalFetched,
          totalProcessed,
          totalFailed,
          totalSkipped,
          runId,
        ],
      );
      log.error({ err, runId }, 'Ingest failed');
    } finally {
      this.currentRunId = null;
      this.stopRequested = false;
    }
  }

  private async runRetry(runId: string, docs: Document[]): Promise<void> {
    let processed = 0;
    let failed = 0;
    let dateFrom: Date | null = null;
    let dateTo: Date | null = null;

    try {
      // Reset all docs to downloaded first
      for (const doc of docs) {
        await this.documentStore.updateStatus(doc.id, 'downloaded', {
          step: 'retry',
          status: 'started',
          timestamp: new Date().toISOString(),
        });
      }

      // Continuous sliding window — same as backfill consumer
      const maxConcurrentDocs = parseInt(process.env.PIPELINE_MAX_CONCURRENT_DOCS ?? '10', 10);
      const docSemaphore = new Semaphore(maxConcurrentDocs);
      const inFlight: Promise<void>[] = [];

      for (const doc of docs) {
        if (this.stopRequested) break;

        await docSemaphore.acquire();

        const p = (async () => {
          try {
            if (this.stopRequested) return;

            const result = await this.orchestrator.processOneDoc(
              doc,
              runId,
              this.stopSignal,
              this.currentStrategy,
              this.currentBypassEmbedCache,
            );

            if (result.status === 'ready') {
              processed++;
              if (doc.publishedAt) {
                const pubDate =
                  doc.publishedAt instanceof Date ? doc.publishedAt : new Date(doc.publishedAt);
                dateFrom = minDate(dateFrom, pubDate);
                dateTo = maxDate(dateTo, pubDate);
              }
              log.info({ sourceId: doc.sourceId, processed }, 'Retry: document processed');
            } else if (result.status === 'failed') {
              failed++;
              log.error({ sourceId: doc.sourceId }, 'Retry: document failed');
            }
          } finally {
            docSemaphore.release();
          }
        })();
        inFlight.push(p);
      }

      await Promise.allSettled(inFlight);

      const finalStatus = this.stopRequested ? 'stopped' : 'completed';

      const costResult = await query<{ total: string }>(
        `SELECT COALESCE(SUM(cost) FILTER (WHERE cost = cost), 0) as total FROM processing_costs
         WHERE created_at >= (SELECT started_at FROM pipeline_runs WHERE id = $1)`,
        [runId],
      );

      await query(
        `UPDATE pipeline_runs SET
          status = $1, finished_at = now(),
          date_from = $2, date_to = $3,
          docs_processed = $4, docs_failed = $5,
          total_cost = $6
         WHERE id = $7`,
        [
          finalStatus,
          dateFrom,
          dateTo,
          processed,
          failed,
          parseFloat(costResult.rows[0]?.total ?? '0'),
          runId,
        ],
      );

      log.info({ runId, status: finalStatus, processed, failed }, 'Retry finished');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
         metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb,
         docs_processed = $2, docs_failed = $3
         WHERE id = $4`,
        [JSON.stringify({ error: errMsg }), processed, failed, runId],
      );
      log.error({ err, runId }, 'Retry failed');
    } finally {
      this.currentRunId = null;
      this.stopRequested = false;
    }
  }

  /** Rebuild the download request (listing entry) from a registry row. */
  private docToEntry(doc: Document): ArxivEntry {
    const pub =
      doc.publishedAt instanceof Date
        ? doc.publishedAt.toISOString()
        : String(doc.publishedAt ?? '');
    return {
      arxivId: doc.sourceId,
      title: doc.title,
      authors: doc.authors ?? [],
      abstract: doc.abstract ?? '',
      categories: doc.categories ?? [],
      publishedAt: pub,
      updatedAt: pub,
      pdfUrl: `https://arxiv.org/pdf/${doc.sourceId}`,
      doi: doc.externalIds?.doi,
      journalRef: doc.externalIds?.journal_ref,
    };
  }

  /**
   * Registry-driven producer (openarx-j173): selects work straight from the
   * per-document registry — no arXiv listing fetch. Selection is
   * self-resuming by construction: processed docs change status and drop out
   * of the WHERE clause, so re-running the same period continues where the
   * previous run stopped.
   *
   *   status='listed'     → download files into the SAME row (read-modify-write
   *                         via applyDownloadSuccess), then hand to the channel
   *   status='downloaded' → hand straight to the channel for processing
   *
   * The `seen` set guards against re-selecting docs whose pipeline processing
   * has not finished yet (status flips to ready/failed only after the
   * consumer is done with them).
   */
  private async produceRegistryDownloads(
    runId: string,
    opts: {
      dateFrom?: string;
      dateTo?: string;
      direction: 'forward' | 'backward';
      categories: string[] | null;
    },
    ch: Channel<{ entry: ArxivEntry; doc: Document }>,
    counters: {
      remaining: number;
      totalFetched: number;
      processed: number;
      failed: number;
      skipped: number;
      dateFrom: Date | null;
      dateTo: Date | null;
    },
    stopFlag: { value: boolean },
  ): Promise<{ downloaded: number; failed: number; infraFailure?: InfraFailure }> {
    let downloaded = 0;
    let failed = 0;
    let infraFailure: InfraFailure | undefined;
    const dlSem = new Semaphore(this.downloadConcurrency);
    const seen = new Set<string>();
    const order = opts.direction === 'backward' ? 'DESC' : 'ASC';

    // Burst detection on download failures (openarx-68f9 analogue): a run of
    // consecutive failures inside a short window means infrastructure trouble
    // (network, proxies, arXiv), not bad documents.
    let consecutiveFailures = 0;
    let firstFailureAt: number | null = null;

    while (counters.remaining > 0 && !this.stopRequested && !stopFlag.value) {
      const conds = [
        `source = 'arxiv'`,
        `status IN ('listed', 'downloaded')`,
        'deleted_at IS NULL',
      ];
      const params: unknown[] = [];
      if (opts.dateFrom) {
        params.push(opts.dateFrom);
        conds.push(`published_at >= $${params.length}::date`);
      }
      if (opts.dateTo) {
        params.push(opts.dateTo);
        conds.push(`published_at < $${params.length}::date + interval '1 day'`);
      }
      if (opts.categories && opts.categories.length > 0) {
        params.push(opts.categories);
        conds.push(`categories && $${params.length}`);
      }
      if (seen.size > 0) {
        params.push([...seen]);
        conds.push(`NOT (id = ANY($${params.length}::uuid[]))`);
      }
      params.push(Math.min(200, counters.remaining));
      const batch = await query<{ id: string }>(
        `SELECT id FROM documents
          WHERE ${conds.join(' AND ')}
          ORDER BY published_at ${order}, id
          LIMIT $${params.length}`,
        params,
      );
      if (batch.rows.length === 0) break; // period exhausted

      await Promise.allSettled(
        batch.rows.map(({ id }) =>
          dlSem.withResource(async () => {
            if (counters.remaining <= 0 || this.stopRequested || stopFlag.value) return;
            seen.add(id);
            const doc = await this.documentStore.getById(id);
            if (!doc || doc.deletedAt) return;

            if (doc.status === 'downloaded') {
              counters.remaining--;
              counters.totalFetched++;
              await ch.send({ entry: this.docToEntry(doc), doc });
              return;
            }
            if (doc.status !== 'listed') return; // raced with another writer

            const entry = this.docToEntry(doc);
            try {
              const { document: downloadedDoc } = await this.arxivSource.downloadAndRegister(
                entry,
                this.documentStore,
                doc,
              );
              counters.remaining--;
              counters.totalFetched++;
              downloaded++;
              consecutiveFailures = 0;
              firstFailureAt = null;
              log.info(
                {
                  arxivId: doc.sourceId,
                  format: downloadedDoc.sourceFormat,
                  remaining: counters.remaining,
                },
                'Downloaded (registry)',
              );
              await ch.send({ entry, doc: downloadedDoc });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.error({ arxivId: doc.sourceId, err: errMsg }, 'Registry download failed');
              try {
                await this.saveFailedDownload(entry, errMsg, doc.id);
              } catch {
                /* non-critical */
              }
              failed++;
              // Permanent 404-class failures don't count toward the infra
              // burst guard (and don't reset it — only a SUCCESS resets):
              // the doc is closed as download_failed, the wave is healthy.
              if (isPermanentDownloadFailure(errMsg)) return;
              if (consecutiveFailures === 0) firstFailureAt = Date.now();
              consecutiveFailures++;
              if (
                consecutiveFailures >= DAY_FAILURE_BURST_THRESHOLD &&
                firstFailureAt !== null &&
                Date.now() - firstFailureAt < DAY_FAILURE_BURST_WINDOW_MS
              ) {
                log.error(
                  { consecutiveFailures, lastError: errMsg },
                  'Consecutive download failures within burst window — likely infrastructure issue, stopping run',
                );
                infraFailure = {
                  reason: 'consecutive_day_failures',
                  count: consecutiveFailures,
                  windowMs: Date.now() - firstFailureAt,
                  lastError: errMsg,
                };
                stopFlag.value = true;
              }
            }
          }),
        ),
      );

      if (seen.size > 100_000) break; // paranoia cap; the limit bounds it anyway
    }

    return { downloaded, failed, infraFailure };
  }

  /**
   * Registry producer + pipeline consumer over a shared channel. The
   * consumer is the same sliding-window flow the per-day model used:
   * concurrent doc processing, fail-rate auto-stop, per-date coverage
   * refresh.
   */
  private async processRegistryParallel(
    runId: string,
    opts: {
      dateFrom?: string;
      dateTo?: string;
      direction: 'forward' | 'backward';
      categories: string[] | null;
    },
    counters: {
      remaining: number;
      totalFetched: number;
      processed: number;
      failed: number;
      skipped: number;
      dateFrom: Date | null;
      dateTo: Date | null;
    },
  ): Promise<{ downloaded: number; failed: number; infraFailure?: InfraFailure }> {
    type DownloadedItem = { entry: ArxivEntry; doc: Document };
    const ch = new Channel<DownloadedItem>(800);
    const stopFlag = { value: false };

    const producer = async (): Promise<{
      downloaded: number;
      failed: number;
      infraFailure?: InfraFailure;
    }> => {
      try {
        return await this.produceRegistryDownloads(runId, opts, ch, counters, stopFlag);
      } finally {
        ch.close();
      }
    };

    const consumer = async (): Promise<void> => {
      const maxConcurrentDocs = parseInt(process.env.PIPELINE_MAX_CONCURRENT_DOCS ?? '10', 10);
      const docSemaphore = new Semaphore(maxConcurrentDocs);
      const inFlight: Promise<void>[] = [];

      let item: DownloadedItem | null;
      while ((item = await ch.receive()) !== null) {
        if (this.stopRequested || stopFlag.value) break;

        const captured = item;
        await docSemaphore.acquire();

        const p = (async () => {
          try {
            if (this.stopRequested || stopFlag.value) return;

            const result = await this.orchestrator.processOneDoc(
              captured.doc,
              runId,
              this.stopSignal,
              this.currentStrategy,
              this.currentBypassEmbedCache,
            );

            if (result.status === 'ready') {
              counters.processed++;
              const pubDate = new Date(captured.entry.publishedAt);
              counters.dateFrom = minDate(counters.dateFrom, pubDate);
              counters.dateTo = maxDate(counters.dateTo, pubDate);
            } else if (result.status === 'failed') {
              counters.failed++;
            }
            await this.updateRunProgress(
              runId,
              counters.processed,
              counters.failed,
              counters.skipped,
              captured.doc.id,
            );

            const totalAttempted = counters.processed + counters.failed;
            if (totalAttempted >= 5 && counters.failed / totalAttempted > this.maxFailRate) {
              log.error(
                { processed: counters.processed, failed: counters.failed },
                'Fail rate exceeded',
              );
              await query(
                `UPDATE pipeline_runs SET metrics = COALESCE(metrics, '{}'::jsonb) || '{"auto_stop": "fail_rate_exceeded"}'::jsonb WHERE id = $1`,
                [runId],
              );
              stopFlag.value = true;
            }
          } finally {
            docSemaphore.release();
          }
        })();
        inFlight.push(p);
      }

      // Drain channel to unblock producer's ch.send()
      while ((await ch.receive()) !== null) {
        /* discard */
      }

      await Promise.allSettled(inFlight);
    };

    const [prodResult] = await Promise.all([producer(), consumer()]);
    return prodResult;
  }

  /**
   * Walk arXiv day listings over the period and register every entry in the
   * per-document registry (status='listed' rows) — the DISCOVERY half of the
   * registry model; downloading/processing is `ingest`. Days are atomic: a
   * started day is always finished, the entry limit is checked at day
   * boundaries.
   */
  private async runRegistryUpdate(
    runId: string,
    opts: { dateFrom?: string; dateTo?: string; direction: 'forward' | 'backward'; limit: number },
  ): Promise<void> {
    let fetched = 0;
    let inserted = 0;
    let daysProcessed = 0;
    const failedDays: string[] = [];

    try {
      const today = new Date().toISOString().slice(0, 10);
      // Single-date-anchor semantics (same as ingest): a lone date is an anchor
      // and direction picks the bound it fills; two dates = explicit range.
      const { lower: bFrom, upper: bTo } = resolveDateBounds(
        opts.dateFrom,
        opts.dateTo,
        opts.direction,
      );
      // Old-format arXiv ids (pre 2007-04) are not parseable by the entry
      // parser — clamp the open lower bound there.
      const lower = bFrom ?? '2007-04-01';
      const upper = bTo && bTo < today ? bTo : today;
      const days = enumerateDays(lower, upper);
      if (opts.direction === 'backward') days.reverse();

      for (const day of days) {
        if (this.stopRequested || fetched >= opts.limit) break;
        const dayCompact = day.replace(/-/g, '');

        try {
          const dayEntries: ArxivEntry[] = [];
          let offset = 0;
          let total = Number.MAX_SAFE_INTEGER;
          while (offset < total && !this.stopRequested) {
            const { total: t, entries } = await this.arxivSource.searchByDateWindow(
              dayCompact,
              offset,
              200,
              this.abortController.signal,
            );
            total = t;
            if (entries.length === 0) break;
            dayEntries.push(...entries);
            offset += entries.length;
          }

          inserted += await this.registerListedEntries(dayEntries);
          fetched += dayEntries.length;
          daysProcessed++;

          await query(
            `UPDATE pipeline_runs SET docs_fetched = $1, docs_processed = $2, backfill_date = $3 WHERE id = $4`,
            [fetched, inserted, day, runId],
          );
          log.info(
            {
              day,
              entries: dayEntries.length,
              listedInserted: inserted,
              fetched,
              limit: opts.limit,
            },
            'registry-update: day complete',
          );
        } catch (err) {
          failedDays.push(day);
          log.error(
            { day, err: err instanceof Error ? err.message : err },
            'registry-update: day failed, continuing with next day',
          );
        }
      }

      const finalStatus = this.stopRequested ? 'stopped' : 'completed';
      await query(
        `UPDATE pipeline_runs SET status = $1, finished_at = now(),
          docs_fetched = $2, docs_processed = $3,
          metrics = COALESCE(metrics, '{}'::jsonb) || $4::jsonb
         WHERE id = $5`,
        [
          finalStatus,
          fetched,
          inserted,
          JSON.stringify({
            days_processed: daysProcessed,
            listed_inserted: inserted,
            failed_days: failedDays,
          }),
          runId,
        ],
      );
      log.info(
        { runId, status: finalStatus, daysProcessed, fetched, inserted, failedDays },
        'Registry update finished',
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
         metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb,
         docs_fetched = $2, docs_processed = $3
         WHERE id = $4`,
        [JSON.stringify({ error: errMsg }), fetched, inserted, runId],
      );
      log.error({ err, runId }, 'Registry update failed');
    } finally {
      this.currentRunId = null;
      this.stopRequested = false;
    }
  }

  /**
   * Per-document registry (openarx-tvts): insert a status='listed' row for
   * every listing entry not yet known in ANY status — metadata only (title,
   * abstract, authors, categories from the Atom feed), no files. Idempotent:
   * re-fetching a day inserts nothing for known papers and never resurrects
   * soft-deleted ones. Non-critical: failure must not block the download pass.
   */
  private async registerListedEntries(entries: ArxivEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    try {
      const rows = buildListedRows(entries);
      const res = await query(buildListedInsertSql(rows.length), flattenListedRows(rows));
      log.debug(
        { entries: entries.length, inserted: res.rowCount ?? 0 },
        'listed registry rows inserted',
      );
      return res.rowCount ?? 0;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'registerListedEntries failed (non-critical)',
      );
      return 0;
    }
  }

  private async updateRunProgress(
    runId: string,
    processed: number,
    failed: number,
    skipped: number,
    lastId: string,
  ): Promise<void> {
    await query(
      `UPDATE pipeline_runs SET docs_processed = $1, docs_failed = $2, docs_skipped = $3, last_processed_id = $4 WHERE id = $5`,
      [processed, failed, skipped, lastId, runId],
    );
  }

  /**
   * @param existingId — id of the existing row for this paper (e.g. a
   * status='listed' registry row). In that case the failure is applied as a
   * read-modify-write partial UPDATE (applyDownloadFailure): status flips,
   * the failure is APPENDED to processing_log, nothing else is touched.
   */
  private async saveFailedDownload(
    entry: ArxivEntry,
    error: string,
    existingId?: string,
  ): Promise<void> {
    if (existingId) {
      await this.documentStore.applyDownloadFailure(existingId, error);
      log.info({ arxivId: entry.arxivId, error }, 'Marked existing row download_failed');
      return;
    }
    const oarxId = computeOarxId('arxiv', entry.arxivId);
    const doc: Document = {
      id: randomUUID(),
      version: 1,
      createdAt: new Date(),
      source: 'arxiv',
      sourceId: entry.arxivId,
      sourceUrl: `https://arxiv.org/abs/${entry.arxivId}`,
      oarxId,
      title: entry.title,
      authors: entry.authors,
      abstract: entry.abstract,
      categories: entry.categories,
      publishedAt: new Date(entry.publishedAt),
      rawContentPath: '',
      structuredContent: null,
      sources: {},
      sourceFormat: undefined,
      codeLinks: [],
      datasetLinks: [],
      benchmarkResults: [],
      status: 'download_failed',
      processingLog: [
        { step: 'download', status: 'failed', timestamp: new Date().toISOString(), error },
      ],
      processingCost: 0,
      provenance: [],
      externalIds: {
        oarx: oarxId,
        arxiv: entry.arxivId,
        ...(entry.doi ? { doi: entry.doi } : {}),
      },
      retryCount: 0,
    };
    await this.documentStore.save(doc);
    log.info({ arxivId: entry.arxivId, error }, 'Saved download_failed document for retry');
  }

  private async getRunById(runId: string): Promise<PipelineRun> {
    const result = await query<Record<string, unknown>>(
      `SELECT * FROM pipeline_runs WHERE id = $1`,
      [runId],
    );
    if (result.rows.length === 0) throw new Error(`Run not found: ${runId}`);
    return rowToRun(result.rows[0]);
  }
}

function rowToRun(row: Record<string, unknown>): PipelineRun {
  return {
    id: String(row.id),
    status: String(row.status) as PipelineRun['status'],
    direction: String(row.direction),
    source: String(row.source),
    categories: row.categories as string[],
    dateFrom: row.date_from ? String(row.date_from) : null,
    dateTo: row.date_to ? String(row.date_to) : null,
    docsFetched: Number(row.docs_fetched ?? 0),
    docsProcessed: Number(row.docs_processed ?? 0),
    docsFailed: Number(row.docs_failed ?? 0),
    docsSkipped: Number(row.docs_skipped ?? 0),
    totalCost: row.total_cost ? Number(row.total_cost) : null,
    metrics: row.metrics as Record<string, unknown> | null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    lastProcessedId: row.last_processed_id ? String(row.last_processed_id) : null,
  };
}
