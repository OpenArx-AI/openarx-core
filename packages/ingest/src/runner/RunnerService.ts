/**
 * RunnerService — business logic for the pipeline runner daemon.
 *
 * Handles: ingest (forward/backfill), stop, status, coverage, history.
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
  query,
  pool,
} from '@openarx/api';
import type { Document } from '@openarx/types';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { ReconciliationLoop } from './reconciliation-loop.js';
import { PwcLoader } from '../pipeline/enricher/pwc-loader.js';
import { ArxivSource } from '../sources/arxiv-source.js';
import type { ArxivEntry } from '../sources/arxiv-source.js';
import { createChildLogger } from '../lib/logger.js';
import { Channel } from '../pipeline/channel.js';
import { initProxyPool } from '../lib/proxy-pool.js';
import { Semaphore } from '../lib/semaphore.js';
import type {
  Direction,
  PipelineRun,
  StatusResult,
  CoverageResult,
  AuditResult,
} from './types.js';

const log = createChildLogger('runner-service');

const RATE_LIMIT_MS = 3000;
const DATA_DIR = process.env.RUNNER_DATA_DIR ?? join(process.cwd(), 'data/samples/arxiv');

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private vectorStore: QdrantVectorStore;
  private orchestrator!: PipelineOrchestrator;
  private arxivSource: ArxivSource;

  private currentRunId: string | null = null;
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
      log.warn({ err: err instanceof Error ? err.message : err }, 'Qdrant deleted-index init non-fatal');
    }

    // Soft-delete reconciliation loop (spec §7.1). Starts timer; ticks
    // every 5 min, catches PG ↔ Qdrant drift from partial admin-API
    // failures.
    this.reconciliationLoop = new ReconciliationLoop(this.vectorStore);
    this.reconciliationLoop.start();

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
      this.documentStore, this.vectorStore, modelRouter,
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
    return this.currentRunId !== null;
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
  ): Promise<PipelineRun> {
    if (this.isRunning) {
      throw new Error('Already running. Use "openarx status" to check progress.');
    }

    this.stopRequested = false;
    this.stopSignal = { requested: false };
    this.abortController = new AbortController();

    // Sync coverage_map with actual DB state (catches docs from retries, manual reprocessing, etc.)
    await this.syncCoverageMap();

    // Create pipeline_run record with launch params in metrics
    const runId = randomUUID();
    const effectiveDirection = direction ?? 'mixed';
    const effectiveStrategy = strategy ?? 'license_aware';
    const effectiveBypassEmbedCache = bypassEmbedCache === true;
    // No env fallback: if caller didn't pass categories, currentCategories
    // stays null and post-fetch filter is bypassed (process everything fetched).
    const effectiveCategories = (categories && categories.length > 0)
      ? categories.map((c) => c.trim()).filter(Boolean)
      : null;
    this.currentStrategy = effectiveStrategy;
    this.currentBypassEmbedCache = effectiveBypassEmbedCache;
    this.currentCategories = effectiveCategories;
    const runParams: Record<string, unknown> = { limit, strategy: effectiveStrategy };
    if (dateFrom) runParams.dateFrom = dateFrom;
    if (dateTo) runParams.dateTo = dateTo;
    if (effectiveBypassEmbedCache) runParams.bypassEmbedCache = true;
    if (effectiveCategories) runParams.categories = effectiveCategories;
    await query(
      `INSERT INTO pipeline_runs (id, status, direction, source, categories, metrics)
       VALUES ($1, 'running', $2, 'arxiv', $3, $4::jsonb)`,
      [runId, effectiveDirection, effectiveCategories ?? [], JSON.stringify({ params: runParams })],
    );
    this.currentRunId = runId;

    log.info(
      { runId, limit, direction: effectiveDirection, dateFrom, dateTo, strategy: effectiveStrategy, bypassEmbedCache: effectiveBypassEmbedCache },
      'Ingest started',
    );

    // Run in background — don't await
    if (effectiveDirection === 'pending_only') {
      this.runPendingOnly(runId).catch((err) => {
        log.error({ err, runId }, 'pending_only failed unexpectedly');
      });
    } else {
      this.runIngest(runId, limit, effectiveDirection, dateFrom, dateTo).catch((err) => {
        log.error({ err, runId }, 'Ingest failed unexpectedly');
      });
    }

    return this.getRunById(runId);
  }

  async retry(limit: number): Promise<PipelineRun> {
    if (this.isRunning) {
      throw new Error('Already running. Use "openarx status" to check progress.');
    }

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

    log.info({ total: retryDocs.length, skippedByFlag: 'skip_retry', cooldown: '3 days' }, 'Retry: filtered docs');

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
  }

  async stop(): Promise<StatusResult> {
    if (!this.isRunning) {
      return { state: 'idle' };
    }
    this.stopRequested = true;
    this.stopSignal.requested = true;
    this.abortController.abort();
    log.info({ runId: this.currentRunId }, 'Stop requested — waiting for in-flight documents to drain');
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

  async coverage(): Promise<CoverageResult> {
    const runsResult = await query<{
      direction: string;
      date_from: string | null;
      date_to: string | null;
      docs_processed: string;
    }>(
      `SELECT direction, date_from, date_to, docs_processed
       FROM pipeline_runs
       WHERE source = 'arxiv' AND status = 'completed' AND direction != 'seed'
         AND docs_processed > 0
       ORDER BY date_from ASC NULLS LAST`,
    );

    const forwardResult = await query<{ cursor: string | null }>(
      `SELECT MAX(date_to) as cursor FROM pipeline_runs
       WHERE source = 'arxiv' AND status = 'completed' AND direction IN ('forward','mixed')`,
    );

    const backfillResult = await query<{ cursor: string | null }>(
      `SELECT MIN(date_from) as cursor FROM pipeline_runs
       WHERE source = 'arxiv' AND status = 'completed' AND direction IN ('backfill','mixed')`,
    );

    const totalResult = await query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM documents WHERE source = 'arxiv' AND status = 'ready'`,
    );

    return {
      source: 'arxiv',
      forwardCursor: forwardResult.rows[0]?.cursor ?? null,
      backfillCursor: backfillResult.rows[0]?.cursor ?? null,
      totalPapers: parseInt(totalResult.rows[0]?.cnt ?? '0', 10),
      runs: runsResult.rows.map((r) => ({
        direction: r.direction,
        dateFrom: r.date_from,
        dateTo: r.date_to,
        docsProcessed: parseInt(r.docs_processed, 10),
      })),
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
      daysChecked: 0, daysComplete: 0, daysWithGaps: 0,
      totalMissing: 0, totalDownloaded: 0, details: [],
    };

    for (const day of daysToCheck) {
      // Count papers in arXiv for this day (single-call probe to get total)
      const { total: arxivCount } = await this.arxivSource.searchByDateWindow(day, 0, 1, this.abortController.signal);

      // Count papers in our DB for this day
      const dbResult = await query<{ cnt: string }>(
        `SELECT count(*) as cnt FROM documents
         WHERE source = 'arxiv'
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
        const { entries } = await this.arxivSource.searchByDateWindow(day, offset, 200, this.abortController.signal);
        if (entries.length === 0) break;

        for (const entry of entries) {
          const existing = await this.documentStore.getBySourceId('arxiv', entry.arxivId);
          if (existing) continue;

          try {
            await this.arxivSource.downloadAndRegister(entry, this.documentStore);
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

    log.info({
      daysChecked: auditResult.daysChecked,
      daysWithGaps: auditResult.daysWithGaps,
      totalDownloaded: auditResult.totalDownloaded,
    }, 'Audit complete');

    return auditResult;
  }

  async doctor(fix?: boolean, check?: string, limit?: number): Promise<import('../doctor/types.js').DoctorReport> {
    if (fix && this.isRunning) {
      throw new Error('Cannot run doctor --fix while ingest is running.');
    }
    const { runDoctor } = await import('../doctor/runner.js');
    const ctx: import('../doctor/types.js').DoctorContext = {
      qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6335',
      qdrantApiKey: process.env.QDRANT_API_KEY,
      fix: !!fix,
      fixLimit: limit,
      modelRouter: fix ? this.orchestrator['modelRouter'] : undefined,
      embedClient: fix ? this.orchestrator['config']?.embedClient : undefined,
    };
    return runDoctor(ctx, { checkName: check });
  }

  async shutdown(): Promise<void> {
    this.stopRequested = true;
    await pool.end();
  }

  // ─── Internal ────────────────────────────────────────────

  private async runIngest(runId: string, limit: number, direction: Direction, dateFromOverride?: string, dateToOverride?: string): Promise<void> {
    let remaining = limit;
    let totalFetched = 0;
    let totalProcessed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let dateFrom: Date | null = null;
    let dateTo: Date | null = null;

    try {
      // Step 0: Process any existing downloaded papers first
      if (remaining > 0 && !this.stopRequested) {
        const pending = await this.documentStore.listByStatus('downloaded', remaining);
        if (pending.length > 0) {
          log.info({ count: pending.length, remaining }, 'Processing existing downloaded papers');
          const report = await this.orchestrator.processAll(
            Math.min(pending.length, remaining), 1, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache,
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
              if (dateResult.rows[0]?.min_date) dateFrom = minDate(dateFrom, dateResult.rows[0].min_date);
              if (dateResult.rows[0]?.max_date) dateTo = maxDate(dateTo, dateResult.rows[0].max_date);
            }
          }

          log.info({ totalProcessed, totalFailed, remaining }, 'Existing downloaded papers processed');
        }
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
          [dateFromOverride ?? null, dateToOverride ?? null, remaining],
        );

        if (abstractOnly.rows.length > 0) {
          const ids = abstractOnly.rows.map(r => r.id);
          await query(
            `UPDATE documents SET status = 'downloaded', indexing_tier = NULL
              WHERE id = ANY($1::uuid[])`,
            [ids],
          );

          log.info({ count: ids.length, remaining, dateFrom: dateFromOverride, dateTo: dateToOverride },
            'force_full: reset abstract_only docs for re-indexing');

          const report = await this.orchestrator.processAll(
            ids.length, 1, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache,
          );

          let step0bProcessed = 0;
          let step0bFailed = 0;
          let step0bSkipped = 0;
          for (const result of report.results) {
            if (result.status === 'ready') { step0bProcessed++; totalProcessed++; }
            else if (result.status === 'failed') { step0bFailed++; totalFailed++; }
            else if (result.status === 'duplicate') { step0bSkipped++; totalSkipped++; }
          }
          remaining -= step0bProcessed + step0bSkipped;

          log.info({ step0bProcessed, step0bFailed, step0bSkipped, remaining },
            'force_full: abstract_only re-indexing complete');
        }
      }

      // Forward pass — fetch newest papers (no date window needed)
      if ((direction === 'forward' || direction === 'mixed') && remaining > 0 && !this.stopRequested) {
        const result = await this.fetchForward(runId, remaining);
        remaining -= result.processed + result.skipped;
        totalFetched += result.fetched;
        totalProcessed += result.processed;
        totalFailed += result.failed;
        totalSkipped += result.skipped;
        dateFrom = minDate(dateFrom, result.dateFrom);
        dateTo = maxDate(dateTo, result.dateTo);
      }

      // Backfill pass — walk backward day by day with date-window pagination
      if ((direction === 'backfill' || direction === 'mixed') && remaining > 0 && !this.stopRequested) {
        const result = await this.fetchBackfill(runId, remaining, dateFromOverride, dateToOverride);
        totalFetched += result.fetched;
        totalProcessed += result.processed;
        totalFailed += result.failed;
        totalSkipped += result.skipped;
        dateFrom = minDate(dateFrom, result.dateFrom);
        dateTo = maxDate(dateTo, result.dateTo);
      }

      // Finalize
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
          docs_fetched = $4, docs_processed = $5, docs_failed = $6, docs_skipped = $7,
          total_cost = $8
         WHERE id = $9`,
        [finalStatus, dateFrom, dateTo, totalFetched, totalProcessed, totalFailed, totalSkipped,
         parseFloat(costResult.rows[0]?.total ?? '0'), runId],
      );

      log.info({
        runId, status: finalStatus, totalProcessed, totalFailed, totalSkipped,
        dateFrom: dateFrom?.toISOString(), dateTo: dateTo?.toISOString(),
      }, 'Ingest finished');

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
         metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb,
         docs_fetched = $2, docs_processed = $3, docs_failed = $4, docs_skipped = $5
         WHERE id = $6`,
        [JSON.stringify({ error: errMsg }), totalFetched, totalProcessed, totalFailed, totalSkipped, runId],
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
          step: 'retry', status: 'started', timestamp: new Date().toISOString(),
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

            const result = await this.orchestrator.processOneDoc(doc, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache);

            if (result.status === 'ready') {
              processed++;
              if (doc.publishedAt) {
                const pubDate = doc.publishedAt instanceof Date ? doc.publishedAt : new Date(doc.publishedAt);
                dateFrom = minDate(dateFrom, pubDate);
                dateTo = maxDate(dateTo, pubDate);
                await this.refreshCoverageForDate(pubDate.toISOString().slice(0, 10));
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
        [finalStatus, dateFrom, dateTo, processed, failed,
         parseFloat(costResult.rows[0]?.total ?? '0'), runId],
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

  /**
   * Process only existing status='downloaded' documents — no fetch from arXiv.
   *
   * Used after enrichment worker marks abstract_only documents for re-indexing
   * (status='downloaded', indexing_tier=NULL). The orchestrator will recompute
   * the indexing tier based on the now-updated license and route through full pipeline.
   */
  private async runPendingOnly(runId: string): Promise<void> {
    let totalProcessed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    try {
      const pending = await this.documentStore.listByStatus('downloaded', 100_000);
      if (pending.length === 0) {
        log.info('pending_only: no downloaded documents to process');
        await query(
          `UPDATE pipeline_runs SET status = 'completed', finished_at = now(),
           docs_processed = 0, docs_failed = 0, docs_skipped = 0
           WHERE id = $1`,
          [runId],
        );
        return;
      }

      log.info({ count: pending.length }, 'pending_only: processing downloaded docs');

      const report = await this.orchestrator!.processAll(
        pending.length, 1, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache,
      );

      for (const result of report.results) {
        if (result.status === 'ready') {
          totalProcessed++;
          // Update coverage_map breakdown for re-indexed docs
          const doc = pending.find(d => d.id === result.documentId);
          if (doc?.publishedAt) {
            const pubDate = doc.publishedAt instanceof Date ? doc.publishedAt : new Date(doc.publishedAt);
            await this.refreshCoverageForDate(pubDate.toISOString().slice(0, 10));
          }
        } else if (result.status === 'failed') {
          totalFailed++;
        } else if (result.status === 'duplicate') {
          totalSkipped++;
        }
      }

      const finalStatus = this.stopRequested ? 'stopped' : 'completed';
      await query(
        `UPDATE pipeline_runs SET status = $1, finished_at = now(),
         docs_processed = $2, docs_failed = $3, docs_skipped = $4
         WHERE id = $5`,
        [finalStatus, totalProcessed, totalFailed, totalSkipped, runId],
      );

      log.info({ runId, status: finalStatus, totalProcessed, totalFailed, totalSkipped }, 'pending_only complete');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE pipeline_runs SET status = 'failed', finished_at = now(),
         metrics = COALESCE(metrics, '{}'::jsonb) || $1::jsonb,
         docs_processed = $2, docs_failed = $3, docs_skipped = $4
         WHERE id = $5`,
        [JSON.stringify({ error: errMsg }), totalProcessed, totalFailed, totalSkipped, runId],
      );
      log.error({ err, runId }, 'pending_only failed');
    } finally {
      this.currentRunId = null;
      this.stopRequested = false;
    }
  }

  private async fetchForward(
    runId: string,
    limit: number,
  ): Promise<{
    fetched: number; processed: number; failed: number; skipped: number;
    dateFrom: Date | null; dateTo: Date | null;
  }> {
    // Determine start date: day after last indexed forward date
    const cursorResult = await query<{ cursor: string | null }>(
      `SELECT MAX(date_to) as cursor FROM pipeline_runs
       WHERE source = 'arxiv' AND status = 'completed'
         AND direction IN ('forward', 'mixed')`,
    );
    let startDate: Date;
    if (cursorResult.rows[0]?.cursor) {
      startDate = new Date(cursorResult.rows[0].cursor);
      startDate.setUTCDate(startDate.getUTCDate() + 1); // Day after last known
    } else {
      // Fallback: day after latest published document
      const docResult = await query<{ latest: Date | null }>(
        `SELECT MAX(published_at) as latest FROM documents WHERE status = 'ready'`,
      );
      if (docResult.rows[0]?.latest) {
        startDate = new Date(docResult.rows[0].latest);
        startDate.setUTCDate(startDate.getUTCDate() + 1);
      } else {
        startDate = new Date();
        startDate.setUTCDate(startDate.getUTCDate() - 1); // Yesterday
      }
    }

    // End date: yesterday (today's papers may not have e-print ready)
    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() - 1);

    log.info({
      limit,
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    }, 'Forward: walking from last indexed date to yesterday');

    let remaining = limit;
    let totalFetched = 0;
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let dateFrom: Date | null = null;
    let dateTo: Date | null = null;
    const MAX_DAYS = 60;

    for (let dayIdx = 0; dayIdx < MAX_DAYS && remaining > 0 && !this.stopRequested; dayIdx++) {
      const d = new Date(startDate);
      d.setUTCDate(d.getUTCDate() + dayIdx);
      if (d > endDate) break;

      const dayStr = d.toISOString().slice(0, 10).replace(/-/g, '');

      try {
        const { total } = await this.arxivSource.searchByDateWindow(dayStr, 0, 1, this.abortController.signal);
        if (total === 0) {
          log.info({ date: dayStr }, 'Forward: empty day, skipping');
          continue;
        }

        log.info({ date: dayStr, total, remaining }, 'Forward: processing day');

        const counters: { remaining: number; totalFetched: number; processed: number; failed: number; skipped: number; dateFrom: Date | null; dateTo: Date | null } = { remaining, totalFetched, processed, failed, skipped, dateFrom, dateTo };
        const dayResult = await this.processDayParallel(runId, dayStr, total, counters);
        ({ remaining, totalFetched, processed, failed, skipped, dateFrom, dateTo } = counters);

        const fmtDateFwd = `${dayStr.slice(0, 4)}-${dayStr.slice(4, 6)}-${dayStr.slice(6, 8)}`;
        await this.refreshCoverageForDate(fmtDateFwd);

        if (dayResult.stopDay) break;
      } catch (err) {
        log.error({ date: dayStr, err: err instanceof Error ? err.message : String(err) }, 'Day processing failed, completing with partial results');
        break;
      }
    }

    return { fetched: totalFetched, processed, failed, skipped, dateFrom, dateTo };
  }

  private async fetchBackfill(
    runId: string,
    limit: number,
    dateFromOverride?: string,
    dateToOverride?: string,
  ): Promise<{
    fetched: number; processed: number; failed: number; skipped: number;
    dateFrom: Date | null; dateTo: Date | null;
  }> {
    // Date range mode: walk forward from dateFrom to dateTo (for gap filling)
    if (dateFromOverride) {
      log.info({ dateFrom: dateFromOverride, dateTo: dateToOverride, limit }, 'Backfill: targeted date range');
      return this.fetchDateRange(runId, limit, dateFromOverride, dateToOverride ?? dateFromOverride);
    }

    // Determine start date: MIN(date_from) from completed runs → YYYYMMDD, subtract 1 day
    const cursorResult = await query<{ cursor: string | null }>(
      `SELECT MIN(date_from) as cursor FROM pipeline_runs
       WHERE source = 'arxiv' AND status = 'completed' AND direction IN ('backfill','mixed')`,
    );
    let startDate: Date;
    if (cursorResult.rows[0]?.cursor) {
      startDate = new Date(cursorResult.rows[0].cursor);
      startDate.setUTCDate(startDate.getUTCDate() - 1); // Start 1 day before last known
    } else {
      // First run — start from yesterday
      startDate = new Date();
      startDate.setUTCDate(startDate.getUTCDate() - 1);
    }

    type DownloadedItem = { entry: ArxivEntry; doc: Document };
    const ch = new Channel<DownloadedItem>(800);
    const counters = { remaining: limit, totalFetched: 0, processed: 0, failed: 0, skipped: 0, dateFrom: null as Date | null, dateTo: null as Date | null };
    const stopDay = { value: false };
    const MAX_DAYS = 60;

    // ─── Producer: walk through days, download and push to shared channel ───
    const producer = async (): Promise<void> => {
      try {
        for (let dayIdx = 0; dayIdx < MAX_DAYS && counters.remaining > 0 && !this.stopRequested && !stopDay.value; dayIdx++) {
          const d = new Date(startDate);
          d.setUTCDate(d.getUTCDate() - dayIdx);
          const dayStr = d.toISOString().slice(0, 10).replace(/-/g, '');

          try {
            // Skip days already fully covered — no need to hit arXiv API
            const fmtDate = `${dayStr.slice(0, 4)}-${dayStr.slice(4, 6)}-${dayStr.slice(6, 8)}`;
            const covResult = await query<{ status: string }>(
              `SELECT status FROM coverage_map WHERE source = 'arxiv' AND date = $1 LIMIT 1`,
              [fmtDate],
            );
            if (covResult.rows[0]?.status === 'complete') {
              log.info({ date: dayStr }, 'Backfill: day already complete in coverage map, skipping');
              continue;
            }

            const { total } = await this.arxivSource.searchByDateWindow(dayStr, 0, 1, this.abortController.signal);
            if (total === 0) {
              log.info({ date: dayStr }, 'Backfill: empty day, skipping');
              continue;
            }

            log.info({ date: dayStr, total, remaining: counters.remaining }, 'Backfill: processing day');
            await this.produceDayDownloads(runId, dayStr, total, ch, counters, stopDay);
            await this.refreshCoverageForDate(fmtDate);
          } catch (err) {
            log.error({ date: dayStr, err: err instanceof Error ? err.message : String(err) }, 'Day processing failed, continuing to next day');
          }
        }
      } finally {
        ch.close();
      }
    };

    // ─── Consumer: continuous sliding window across ALL days ───
    const consumer = async (): Promise<void> => {
      const maxConcurrentDocs = parseInt(process.env.PIPELINE_MAX_CONCURRENT_DOCS ?? '10', 10);
      const docSemaphore = new Semaphore(maxConcurrentDocs);
      const inFlight: Promise<void>[] = [];

      let item: DownloadedItem | null;
      while ((item = await ch.receive()) !== null) {
        if (this.stopRequested || stopDay.value) break;

        const captured = item;
        await docSemaphore.acquire();

        const p = (async () => {
          try {
            if (this.stopRequested || stopDay.value) return;

            const result = await this.orchestrator.processOneDoc(captured.doc, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache);

            if (result.status === 'ready') {
              counters.processed++;
              const pubDate = new Date(captured.entry.publishedAt);
              counters.dateFrom = minDate(counters.dateFrom, pubDate);
              counters.dateTo = maxDate(counters.dateTo, pubDate);
              await this.refreshCoverageForDate(pubDate.toISOString().slice(0, 10));
            } else if (result.status === 'failed') {
              counters.failed++;
            }

            const totalAttempted = counters.processed + counters.failed;
            if (totalAttempted >= 5 && counters.failed / totalAttempted > this.maxFailRate) {
              log.error({ processed: counters.processed, failed: counters.failed }, 'Fail rate exceeded');
              await query(
                `UPDATE pipeline_runs SET metrics = COALESCE(metrics, '{}'::jsonb) || '{"auto_stop": "fail_rate_exceeded"}'::jsonb WHERE id = $1`,
                [runId],
              );
              stopDay.value = true;
            }
          } finally {
            docSemaphore.release();
          }
        })();
        inFlight.push(p);
      }

      // Drain remaining channel items to unblock producer's ch.send().
      // Without this, producer deadlocks on send() because channel is full and nobody reads.
      while (await ch.receive() !== null) { /* discard */ }

      await Promise.allSettled(inFlight);
    };

    await Promise.all([producer(), consumer()]);

    return { fetched: counters.totalFetched, processed: counters.processed, failed: counters.failed, skipped: counters.skipped, dateFrom: counters.dateFrom, dateTo: counters.dateTo };
  }

  /**
   * Download + process a single day's papers with producer-consumer parallelism.
   * Producer downloads papers and pushes to a bounded channel.
   * Consumer pulls batches from channel and runs processAll().
   * Both run concurrently — download doesn't block during processing.
   */
  /** Targeted date range backfill — walks forward from dateFrom to dateTo with shared-channel sliding window. */
  private async fetchDateRange(
    runId: string, limit: number, from: string, to: string,
  ): Promise<{ fetched: number; processed: number; failed: number; skipped: number; dateFrom: Date | null; dateTo: Date | null }> {
    const startDate = new Date(from);
    const endDate = new Date(to);

    type DownloadedItem = { entry: ArxivEntry; doc: Document };
    const ch = new Channel<DownloadedItem>(800);
    const counters = { remaining: limit, totalFetched: 0, processed: 0, failed: 0, skipped: 0, dateFrom: null as Date | null, dateTo: null as Date | null };
    const stopDay = { value: false };

    // ─── Producer: walk forward from dateFrom to dateTo, push to shared channel ───
    const producer = async (): Promise<void> => {
      try {
        for (let dayIdx = 0; counters.remaining > 0 && !this.stopRequested && !stopDay.value; dayIdx++) {
          const d = new Date(startDate);
          d.setUTCDate(d.getUTCDate() + dayIdx);
          if (d > endDate) break;

          const dayStr = d.toISOString().slice(0, 10).replace(/-/g, '');

          try {
            const fmtDate = `${dayStr.slice(0, 4)}-${dayStr.slice(4, 6)}-${dayStr.slice(6, 8)}`;

            // Skip days already fully covered
            const covResult = await query<{ status: string }>(
              `SELECT status FROM coverage_map WHERE source = 'arxiv' AND date = $1 LIMIT 1`,
              [fmtDate],
            );
            if (covResult.rows[0]?.status === 'complete') {
              log.info({ date: dayStr }, 'Date range: day already complete, skipping');
              continue;
            }

            const { total } = await this.arxivSource.searchByDateWindow(dayStr, 0, 1, this.abortController.signal);
            if (total === 0) { log.info({ date: dayStr }, 'Date range: empty day'); continue; }

            log.info({ date: dayStr, total, remaining: counters.remaining }, 'Date range: processing day');
            await this.produceDayDownloads(runId, dayStr, total, ch, counters, stopDay);
            await this.refreshCoverageForDate(fmtDate);
          } catch (err) {
            log.error({ date: dayStr, err: err instanceof Error ? err.message : String(err) }, 'Day processing failed, continuing to next day');
          }
        }
      } finally {
        ch.close();
      }
    };

    // ─── Consumer: continuous sliding window across ALL days ───
    const consumer = async (): Promise<void> => {
      const maxConcurrentDocs = parseInt(process.env.PIPELINE_MAX_CONCURRENT_DOCS ?? '10', 10);
      const docSemaphore = new Semaphore(maxConcurrentDocs);
      const inFlight: Promise<void>[] = [];

      let item: DownloadedItem | null;
      while ((item = await ch.receive()) !== null) {
        if (this.stopRequested || stopDay.value) break;

        const captured = item;
        await docSemaphore.acquire();

        const p = (async () => {
          try {
            if (this.stopRequested || stopDay.value) return;

            const result = await this.orchestrator.processOneDoc(captured.doc, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache);

            if (result.status === 'ready') {
              counters.processed++;
              const pubDate = new Date(captured.entry.publishedAt);
              counters.dateFrom = minDate(counters.dateFrom, pubDate);
              counters.dateTo = maxDate(counters.dateTo, pubDate);
              await this.refreshCoverageForDate(pubDate.toISOString().slice(0, 10));
            } else if (result.status === 'failed') {
              counters.failed++;
            }

            const totalAttempted = counters.processed + counters.failed;
            if (totalAttempted >= 5 && counters.failed / totalAttempted > this.maxFailRate) {
              log.error({ processed: counters.processed, failed: counters.failed }, 'Fail rate exceeded');
              await query(
                `UPDATE pipeline_runs SET metrics = COALESCE(metrics, '{}'::jsonb) || '{"auto_stop": "fail_rate_exceeded"}'::jsonb WHERE id = $1`,
                [runId],
              );
              stopDay.value = true;
            }
          } finally {
            docSemaphore.release();
          }
        })();
        inFlight.push(p);
      }

      // Drain remaining channel items to unblock producer's ch.send()
      while (await ch.receive() !== null) { /* discard */ }

      await Promise.allSettled(inFlight);
    };

    await Promise.all([producer(), consumer()]);

    return { fetched: counters.totalFetched, processed: counters.processed, failed: counters.failed, skipped: counters.skipped, dateFrom: counters.dateFrom, dateTo: counters.dateTo };
  }

  /**
   * Download + process a single day's papers with producer-consumer parallelism.
   * Accepts an external channel + consumer state so the producer can feed docs
   * across multiple days without waiting for consumer to finish the current day.
   */
  private async produceDayDownloads(
    runId: string,
    dayStr: string,
    total: number,
    ch: Channel<{ entry: ArxivEntry; doc: Document }>,
    counters: { remaining: number; totalFetched: number; processed: number; failed: number; skipped: number; dateFrom: Date | null; dateTo: Date | null },
    stopDay: { value: boolean },
  ): Promise<{ dayDownloaded: number; dayFailed: number; daySkipped: number }> {
    let dayDownloaded = 0;
    let dayFailed = 0;
    let daySkipped = 0;
    const dlSem = new Semaphore(this.downloadConcurrency);

    // Pre-build category filter set once. null = no filter (process all).
    const wantCats = this.currentCategories ? new Set(this.currentCategories) : null;

    let offset = 0;
    while (offset < total && counters.remaining > 0 && !this.stopRequested && !stopDay.value) {
      const { entries } = await this.arxivSource.searchByDateWindow(dayStr, offset, 200, this.abortController.signal);
      if (entries.length === 0) break;
      counters.totalFetched += entries.length;

      // Bump coverage_map.expected per-cat for ALL fetched entries — we
      // know these papers exist on arxiv this day, regardless of whether we
      // download/process them. Cross-listed papers count in every cat.
      await this.bumpCoverageExpected(dayStr, entries);

      // Post-fetch processing filter. wantCats=null → process every paper
      // (no per-run filter); else keep only ones whose categories intersect.
      const toProcess: ArxivEntry[] = wantCats
        ? entries.filter((e) => (e.categories ?? []).some((c) => wantCats.has(c)))
        : entries;
      const filteredOut = entries.length - toProcess.length;
      if (filteredOut > 0) {
        log.info({ dayStr, fetched: entries.length, processing: toProcess.length, filteredOut }, 'post-fetch category filter applied');
      }

      await Promise.allSettled(toProcess.map((entry) => dlSem.withResource(async () => {
        if (counters.remaining <= 0 || this.stopRequested || stopDay.value) return;

        const existing = await this.documentStore.getBySourceId('arxiv', entry.arxivId);
        if (existing) {
          if (existing.status === 'download_failed' && existing.retryCount < this.maxDownloadRetries) {
            try {
              const { document: doc } = await this.arxivSource.downloadAndRegister(entry, this.documentStore);
              await query('UPDATE documents SET status = $1, retry_count = retry_count + 1, raw_content_path = $2, sources = $3, source_format = $4 WHERE id = $5',
                ['downloaded', doc.rawContentPath, JSON.stringify(doc.sources), doc.sourceFormat, existing.id]);
              counters.remaining--;
              dayDownloaded++;
              await ch.send({ entry, doc: { ...doc, id: existing.id } });
              log.info({ arxivId: entry.arxivId, retry: existing.retryCount + 1 }, 'Retry download succeeded');
            } catch (err) {
              await query('UPDATE documents SET retry_count = retry_count + 1 WHERE id = $1', [existing.id]);
              log.warn({ arxivId: entry.arxivId, retry: existing.retryCount + 1 }, 'Retry download failed again');
              dayFailed++;
            }
          } else {
            counters.skipped++;
            daySkipped++;
          }
          return;
        }

        try {
          const { document: doc } = await this.arxivSource.downloadAndRegister(entry, this.documentStore);
          counters.remaining--;
          dayDownloaded++;
          log.info({ arxivId: entry.arxivId, format: doc.sourceFormat, remaining: counters.remaining }, 'Downloaded');
          await ch.send({ entry, doc });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error({ arxivId: entry.arxivId, err: errMsg }, 'Download failed');
          try { await this.saveFailedDownload(entry, errMsg); } catch { /* non-critical */ }
          dayFailed++;
        }
      })));

      offset += entries.length;
      await query(
        `UPDATE pipeline_runs SET backfill_date = $1, backfill_offset = $2 WHERE id = $3`,
        [dayStr, offset, runId],
      );
    }

    return { dayDownloaded, dayFailed, daySkipped };
  }

  /**
   * After fetching a day's entries from OAI-PMH, count papers per arxiv-cat
   * and write coverage_map.expected (= papers existing on arxiv for this
   * date with this cat). UPSERT preserves actual/breakdown which are
   * maintained separately by refreshCoverageForDate.
   *
   * Each paper increments expected for every cat in its categories[].
   */
  private async bumpCoverageExpected(dayStr: string, entries: ArxivEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // ISO date for SQL
    const dateIso = dayStr.length === 8
      ? `${dayStr.slice(0, 4)}-${dayStr.slice(4, 6)}-${dayStr.slice(6, 8)}`
      : dayStr;
    const expectedPerCat = new Map<string, number>();
    for (const e of entries) {
      for (const cat of e.categories ?? []) {
        expectedPerCat.set(cat, (expectedPerCat.get(cat) ?? 0) + 1);
      }
    }
    try {
      for (const [cat, count] of expectedPerCat) {
        await query(
          `INSERT INTO coverage_map
             (source, category, date, expected, actual, download_failed, skipped, status, breakdown, last_checked_at)
           VALUES ('arxiv', $1, $2::date, $3, 0, 0, 0, 'expected_unknown', '{}'::jsonb, now())
           ON CONFLICT (source, category, date) DO UPDATE SET
             expected = EXCLUDED.expected,
             status = CASE
               WHEN coverage_map.actual >= EXCLUDED.expected THEN 'complete'
               WHEN coverage_map.actual > 0 THEN 'partial'
               ELSE 'not_started'
             END,
             last_checked_at = now()`,
          [cat, dateIso, count],
        );
      }
      log.debug({ dayStr, cats: expectedPerCat.size, entries: entries.length }, 'coverage_map.expected bumped per-cat');
    } catch (err) {
      log.warn({ dayStr, err: err instanceof Error ? err.message : err }, 'bumpCoverageExpected failed (non-critical)');
    }
  }

  /**
   * Run producer (multi-day) + consumer concurrently with a shared channel.
   * Producer walks through days, downloading and pushing to channel.
   * Consumer processes docs individually with sliding window — no batch boundaries.
   */
  private async processDayParallel(
    runId: string,
    dayStr: string,
    total: number,
    counters: { remaining: number; totalFetched: number; processed: number; failed: number; skipped: number; dateFrom: Date | null; dateTo: Date | null },
  ): Promise<{ dayDownloaded: number; dayFailed: number; daySkipped: number; stopDay: boolean }> {
    type DownloadedItem = { entry: ArxivEntry; doc: Document };
    const ch = new Channel<DownloadedItem>(800);
    const stopDay = { value: false };

    const producer = async (): Promise<{ dayDownloaded: number; dayFailed: number; daySkipped: number }> => {
      try {
        return await this.produceDayDownloads(runId, dayStr, total, ch, counters, stopDay);
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
        if (this.stopRequested || stopDay.value) break;

        const captured = item;
        await docSemaphore.acquire();

        const p = (async () => {
          try {
            if (this.stopRequested || stopDay.value) return;

            const result = await this.orchestrator.processOneDoc(captured.doc, runId, this.stopSignal, this.currentStrategy, this.currentBypassEmbedCache);

            if (result.status === 'ready') {
              counters.processed++;
              const pubDate = new Date(captured.entry.publishedAt);
              counters.dateFrom = minDate(counters.dateFrom, pubDate);
              counters.dateTo = maxDate(counters.dateTo, pubDate);
              await this.refreshCoverageForDate(pubDate.toISOString().slice(0, 10));
            } else if (result.status === 'failed') {
              counters.failed++;
            }

            const totalAttempted = counters.processed + counters.failed;
            if (totalAttempted >= 5 && counters.failed / totalAttempted > this.maxFailRate) {
              log.error({ processed: counters.processed, failed: counters.failed }, 'Fail rate exceeded');
              await query(
                `UPDATE pipeline_runs SET metrics = COALESCE(metrics, '{}'::jsonb) || '{"auto_stop": "fail_rate_exceeded"}'::jsonb WHERE id = $1`,
                [runId],
              );
              stopDay.value = true;
            }
          } finally {
            docSemaphore.release();
          }
        })();
        inFlight.push(p);
      }

      // Drain channel to unblock producer's ch.send() (same deadlock fix as fetchBackfill)
      while (await ch.receive() !== null) { /* discard */ }

      await Promise.allSettled(inFlight);
    };

    const [dayResult] = await Promise.all([producer(), consumer()]);

    return { ...dayResult, stopDay: stopDay.value };
  }

  /**
   * Refresh coverage_map for a single date by aggregating per-arxiv-category
   * counts from `documents` (truth source). Replaces both the old
   * `updateCoverage` (per-day finalize) and `incrementBreakdown` (per-doc
   * progressive update) — coverage_map is now a derived view of documents.
   *
   * One paper with categories=[cs.AI, cs.LG] increments rows for BOTH cs.AI
   * and cs.LG. Sum of `actual` across categories > unique paper count, but
   * per-cat numbers are correct relative to documents.
   *
   * `expected` is preserved on conflict (set to NULL on first insert) — it
   * is filled by a separate offline OAI-PMH refill (Phase 6, planned).
   *
   * Idempotent: every call recomputes from documents, drift impossible.
   * Non-blocking: errors are logged but don't fail the pipeline.
   */
  private async refreshCoverageForDate(dateStr: string): Promise<void> {
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

    try {
      const docs = await query<DocRow>(
        `SELECT status, categories, license, indexing_tier
         FROM documents
         WHERE source = 'arxiv' AND published_at::date = $1::date`,
        [dateStr],
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
              break;
          }
        }
      }

      if (stats.size === 0) return;

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
      log.debug({ date: dateStr, cats: stats.size }, 'coverage_map refreshed for date');
    } catch (err) {
      log.warn({ date: dateStr, err: err instanceof Error ? err.message : err }, 'refreshCoverageForDate failed (non-critical)');
    }
  }

  /**
   * Sync coverage_map per-arxiv-category from documents. Runs once at start
   * of each ingest run. Catches drift from manual reprocessing, retries, or
   * doc state changes outside the runner's incremental refresh path.
   *
   * Refreshes any date that has documents whose per-cat aggregation differs
   * from what's in coverage_map. Skips dates where everything matches.
   */
  private async syncCoverageMap(): Promise<void> {
    try {
      // Find dates where documents per-cat sum doesn't match coverage_map.
      // Cheap heuristic: total ready papers per date in documents vs sum(actual)
      // /N (avg cats per paper). For correctness fall back to refreshing any
      // date with a document whose published_at::date doesn't have a complete
      // coverage_map entry.
      const stale = await query<{ pub_date: string }>(
        `WITH doc_dates AS (
           SELECT DISTINCT published_at::date AS pub_date
           FROM documents
           WHERE source = 'arxiv' AND published_at IS NOT NULL
         )
         SELECT pub_date::text FROM doc_dates
         WHERE NOT EXISTS (
           SELECT 1 FROM coverage_map cm
           WHERE cm.source = 'arxiv' AND cm.date = doc_dates.pub_date
             AND cm.last_checked_at > now() - interval '1 hour'
         )
         ORDER BY pub_date DESC
         LIMIT 60`,
      );

      if (stale.rows.length === 0) {
        log.info('Coverage map: nothing to sync');
        return;
      }

      log.info({ dates: stale.rows.length }, 'Coverage map: refreshing stale dates');
      let refreshed = 0;
      for (const row of stale.rows) {
        await this.refreshCoverageForDate(row.pub_date);
        refreshed++;
      }
      log.info({ refreshed }, 'Coverage map sync complete');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Coverage map sync failed (non-critical)');
    }
  }

  private async updateRunProgress(
    runId: string, processed: number, failed: number, skipped: number, lastId: string,
  ): Promise<void> {
    await query(
      `UPDATE pipeline_runs SET docs_processed = $1, docs_failed = $2, docs_skipped = $3, last_processed_id = $4 WHERE id = $5`,
      [processed, failed, skipped, lastId, runId],
    );
  }

  private async saveFailedDownload(entry: ArxivEntry, error: string): Promise<void> {
    const { createHash } = await import('node:crypto');
    const oarxId = 'oarx-' + createHash('sha256').update(`arxiv:${entry.arxivId}`).digest('hex').slice(0, 8);
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
      processingLog: [{ step: 'download', status: 'failed', timestamp: new Date().toISOString(), error }],
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
