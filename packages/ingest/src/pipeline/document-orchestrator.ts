/**
 * DocumentOrchestrator — resource-pool-based pipeline driver.
 *
 * The orchestrator
 * runs each document independently through its route, acquiring resource
 * pool slots on demand. Documents don't block each other unless they
 * compete for the same scarce resource.
 *
 * Usage:
 *   const orch = new DocumentOrchestrator(steps, config);
 *   const report = await orch.processDocuments(docs);
 */

import type { Document, DocumentStore, ParsedDocument, ProcessingLogEntry } from '@openarx/types';
import { query, PgChunkStore, markReviewFailed } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';
import { appendProvenance } from '../lib/provenance.js';
import { computeQualityMetrics } from '../lib/quality-metrics.js';
import { BUILD_VERSION } from '../lib/build-info.js';
import { PgCostTracker } from './cost-tracker.js';
import { ResourcePool } from './resource-pool.js';
import { Semaphore } from '../lib/semaphore.js';
import { loadPoolConfig, loadMaxConcurrentDocs } from './pool-config.js';
import { selectRoute } from './routes.js';
import { WORKERS, DuplicateError } from './workers.js';
import { ChunkingAbortedError } from './chunker-step.js';
import type { WorkItem, WorkItemTiming, PipelineSteps } from './workers.js';
import type { ProcessingReport } from './orchestrator.js';
import { isOpenLicense } from '../lib/license-normalizer.js';

const PERSIST_CHUNKS_BEFORE_EMBED =
  (process.env.PERSIST_CHUNKS_BEFORE_EMBED ?? 'false').toLowerCase() === 'true';

type ResumeState = 'virgin' | 'resume' | 'rerun';

const log = createChildLogger('doc-orchestrator');

export interface DocumentOrchestratorConfig {
  pipelineRunId?: string;
  stopSignal?: { requested: boolean };
  /** Indexing strategy. Defaults to 'license_aware'. */
  strategy?: 'license_aware' | 'force_full';
}

/**
 * Compute the indexing tier for a document based on license + strategy.
 *
 * - 'force_full' strategy → always 'full' (ignore license)
 * - 'license_aware' (default):
 *   - If indexingTier already set explicitly on doc → respect it (manual override)
 *   - If license unknown (NOASSERTION/null) → 'full' (permissive default)
 *   - If license is open → 'full'
 *   - Otherwise → 'abstract_only'
 */
export function computeIndexingTier(
  doc: Document,
  strategy: 'license_aware' | 'force_full' = 'license_aware',
): 'full' | 'abstract_only' {
  if (strategy === 'force_full') return 'full';
  if (doc.indexingTier) return doc.indexingTier;
  if (!doc.license || doc.license === 'NOASSERTION') return 'full';
  return isOpenLicense(doc.license) ? 'full' : 'abstract_only';
}

export class DocumentOrchestrator {
  private readonly pool: ResourcePool;
  private readonly maxConcurrent: number;
  private readonly chunkStore: PgChunkStore;

  constructor(
    private readonly steps: PipelineSteps,
    private readonly config: DocumentOrchestratorConfig = {},
  ) {
    // Initialize resource pool from env config
    this.pool = new ResourcePool();
    const capacities = loadPoolConfig();
    for (const [name, cap] of Object.entries(capacities)) {
      if (cap > 0) this.pool.register(name, cap);
    }
    this.maxConcurrent = loadMaxConcurrentDocs();

    // ChunkStore is shared. Inject into steps so workers can reach it without
    // re-constructing per-doc.
    this.chunkStore = new PgChunkStore();
    if (!this.steps.chunkStore) this.steps.chunkStore = this.chunkStore;

    log.info(
      { capacities, maxConcurrent: this.maxConcurrent, persistChunks: PERSIST_CHUNKS_BEFORE_EMBED },
      'Resource pool initialized',
    );
  }

  /** Process multiple documents concurrently, respecting resource pool limits. */
  async processDocuments(documents: Document[]): Promise<ProcessingReport> {
    const report: ProcessingReport = {
      total: documents.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };

    if (documents.length === 0) return report;

    // Sliding window: semaphore keeps exactly maxConcurrent docs in flight.
    // As soon as one finishes, the next starts — no batch boundary stalls.
    const docSemaphore = new Semaphore(this.maxConcurrent);

    // Callback fires immediately when each doc completes — real-time DB updates.
    const onDocComplete = (entry: ProcessingReport['results'][number]): void => {
      report.results.push(entry);
      if (entry.status === 'ready') report.succeeded++;
      else if (entry.status === 'duplicate') report.skipped++;
      else report.failed++;
      this.updatePipelineRun(entry);
    };

    await Promise.allSettled(
      documents.map((doc) =>
        docSemaphore.withResource(async () => {
          if (this.config.stopSignal?.requested) return;
          const entry = await this.processOne(doc);
          onDocComplete(entry);
        }),
      ),
    );

    log.info({
      total: report.total,
      succeeded: report.succeeded,
      failed: report.failed,
      skipped: report.skipped,
      poolStats: this.pool.stats(),
    }, 'Document orchestrator complete');

    return report;
  }

  /** Process a single document through its route. */
  async processOne(doc: Document): Promise<ProcessingReport['results'][number]> {
    const startMs = performance.now();
    const costTracker = new PgCostTracker(doc.id);
    const docLog = createChildLogger(`pool:${doc.sourceId}`);

    const context = {
      documentId: doc.id,
      modelRouter: this.steps.modelRouter,
      config: { stopSignal: this.config.stopSignal },
      logger: {
        debug: (msg: string, data?: unknown) => docLog.debug(toObj(data), msg),
        info: (msg: string, data?: unknown) => docLog.info(toObj(data), msg),
        warn: (msg: string, data?: unknown) => docLog.warn(toObj(data), msg),
        error: (msg: string, data?: unknown) => docLog.error(toObj(data), msg),
      },
      costTracker,
    };

    const timing: WorkItemTiming = {
      parseMs: 0, chunkMs: 0, enrichMs: 0,
      embedGeminiMs: 0, embedSpecterMs: 0,
      indexMs: 0, totalMs: 0,
    };

    const item: WorkItem = { document: doc, context, timing, startMs };
    // Pipeline gate: decide indexing tier based on license + run strategy.
    // Sets it on the document so that downstream steps (indexer) record it
    // and abstract-only path is taken via selectRoute().
    const effectiveTier = computeIndexingTier(doc, this.config.strategy);
    doc.indexingTier = effectiveTier;
    let route = selectRoute(doc.sourceFormat, effectiveTier);

    // Resume-mode decision (openarx-q2eh): if the doc already has persisted
    // pending/embedded chunks from a prior failed run, resume from embed
    // instead of re-running parse+chunk. Only active when feature flag is on.
    let resumeState: ResumeState = 'virgin';
    if (PERSIST_CHUNKS_BEFORE_EMBED) {
      resumeState = await this.detectResumeState(doc.id, effectiveTier);
      if (resumeState === 'resume') {
        const loaded = await this.chunkStore.loadChunksForResume(doc.id);
        if (loaded.length > 0) {
          item.chunks = loaded;
          item.resumed = true;
          item.parsedDocument = await this.reconstructParsedDocument(doc);
          // Filter the route: drop parse / translate / chunk / abstract_chunk.
          const skip = new Set(['parse', 'translate', 'chunk', 'abstract_chunk']);
          route = route.filter((s) => !skip.has(s.worker));
          docLog.info(
            { loaded: loaded.length, resumeState, stepsSkipped: Array.from(skip) },
            'Resuming from persisted chunks',
          );
        } else {
          resumeState = 'virgin';
        }
      } else if (resumeState === 'rerun') {
        // All existing chunks indexed but doc reset to downloaded (operator
        // reprocess). Clear PG + Qdrant so chunker can insert fresh pending
        // rows without leaving orphan Qdrant points behind.
        await this.steps.indexerStep.deleteExistingChunks(doc.id, context.logger);
        docLog.info('Rerun: cleared existing indexed chunks (PG + Qdrant)');
      }
    }

    // DEBUG: pipeline gate decision trace
    log.debug({
      docId: doc.id,
      sourceId: doc.sourceId,
      license: doc.license ?? null,
      licenses: doc.licenses ?? {},
      strategy: this.config.strategy ?? 'license_aware',
      decided_tier: effectiveTier,
      route_name: effectiveTier === 'abstract_only' ? 'ABSTRACT_ONLY'
        : doc.sourceFormat === 'latex' ? 'LATEX'
        : doc.sourceFormat === 'markdown' ? 'MARKDOWN'
        : 'PDF',
      route_steps: route.map((s) => s.name),
      resume_state: resumeState,
    }, '[pipeline-gate] indexing tier decided');

    let stoppedEarly = false;

    try {
      for (const step of route) {
        if (this.config.stopSignal?.requested) {
          // Graceful stop: don't mark as failed — leave doc in current status
          // so it can be resumed/retried without re-doing completed steps.
          stoppedEarly = true;
          docLog.info('Pipeline stop requested — suspending before next step');
          break;
        }

        // Skip step if its resource is disabled (capacity=0)
        if (!this.pool.has(step.resource)) continue;

        const workerFn = WORKERS[step.worker];
        if (!workerFn) throw new Error(`Unknown worker: ${step.worker}`);

        const status = stepToStatus(step.name);
        if (status) {
          await this.updateStatus(doc.id, status, step.name, 'started');
        }

        await this.pool.withResource(step.resource, async () => {
          await workerFn(item, this.steps);
        });
      }

      // Stopped early — return doc to 'downloaded' so it's picked up by next run.
      // Pipeline is idempotent (indexer deletes existing chunks), so full reprocessing is safe.
      if (stoppedEarly) {
        const durationMs = Math.round(performance.now() - startMs);
        await this.updateStatus(doc.id, 'downloaded', 'pipeline', 'started');
        docLog.info({ durationMs }, 'Document returned to downloaded (stop requested)');
        return { documentId: doc.id, sourceId: doc.sourceId, status: 'duplicate', durationMs };
      }

      // All steps done — finalize
      timing.totalMs = Math.round(performance.now() - startMs);

      // Invariant: pipeline cannot end in status='ready' with zero chunks.
      // Root-path used to mark such docs ready silently (see openarx-panb,
      // openarx-fj3t); indexer-step early-returned on 0 chunks but nothing
      // refused the final `updateStatus('ready')`. Throwing here routes
      // the doc to the catch block → `updateStatus('failed', ...)` below,
      // so Portal polling + auto-reindex see an accurate state.
      //
      // Resumed runs may legitimately have `item.chunks` unset in memory
      // (chunks live in PG from a prior run); in that case we verify via
      // DB. Abstract-only tier always has ≥1 chunk from abstract_chunk
      // worker, so this check is uniform across routes.
      const inMemoryChunks = item.chunks?.length ?? 0;
      let chunkCount = inMemoryChunks;
      if (chunkCount === 0 && item.resumed) {
        const r = await query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM chunks WHERE document_id = $1`,
          [doc.id],
        );
        chunkCount = parseInt(r.rows[0]?.cnt ?? '0', 10);
      }
      if (chunkCount === 0) {
        throw new Error('pipeline_produced_zero_chunks');
      }

      // Chunk batch count
      const batchResult = await query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM processing_costs WHERE document_id = $1 AND task = 'chunking' AND created_at > NOW() - INTERVAL '1 hour'`,
        [doc.id],
      );
      timing.chunkBatches = Number(batchResult.rows[0]?.cnt ?? 0);

      await query(
        `UPDATE documents SET quality_flags = COALESCE(quality_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ pipeline_timing: timing }), doc.id],
      );

      // Quality metrics — non-blocking, but always called so parse_quality +
      // quality_flags are populated on every successful finalize. Missing from
      // this path since the resource-pool rewrite (34d38f5, 2026-03-23) —
      // closes openarx-fj3t (47% of recent reindex had parse_quality=NULL).
      try {
        await computeQualityMetrics(doc.id);
      } catch (err) {
        docLog.warn(
          `quality metrics failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      await this.updateStatus(doc.id, 'ready', 'pipeline', 'completed');
      await appendProvenance(doc.id, {
        op: 'ingest',
        pipeline_version: BUILD_VERSION,
        source_format: doc.sourceFormat ?? 'pdf',
        chunks_total: item.chunks?.length ?? 0,
        duration_ms: timing.totalMs,
      });

      const fmtSec = (ms: number): string => (ms / 1000).toFixed(1) + 's';
      docLog.info(
        `[timing] ${doc.sourceId} | parse: ${fmtSec(timing.parseMs)} | chunk: ${fmtSec(timing.chunkMs)} | enrich: ${fmtSec(timing.enrichMs)} | embed: ${fmtSec(timing.embedGeminiMs)}+${fmtSec(timing.embedSpecterMs)} | index: ${fmtSec(timing.indexMs)} | total: ${fmtSec(timing.totalMs)}`,
      );

      return {
        documentId: doc.id,
        sourceId: doc.sourceId,
        status: 'ready',
        chunks: item.chunks?.length,
        durationMs: timing.totalMs,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startMs);

      if (err instanceof DuplicateError) {
        await this.updateStatus(doc.id, 'duplicate', 'dedup', 'completed');
        return { documentId: doc.id, sourceId: doc.sourceId, status: 'duplicate', durationMs };
      }

      if (err instanceof ChunkingAbortedError) {
        // Stop requested mid-chunking — return doc to 'downloaded' so it can
        // be retried later. Clean up any partially-persisted chunks from this
        // aborted run so the next attempt starts fresh (openarx-q2eh).
        if (PERSIST_CHUNKS_BEFORE_EMBED) {
          const deleted = await this.chunkStore.deletePendingByDocumentId(doc.id);
          if (deleted > 0) {
            docLog.info({ deleted }, 'Cleaned up partial chunks from aborted chunking');
          }
        }
        await this.updateStatus(doc.id, 'downloaded', 'pipeline', 'started');
        docLog.info({ durationMs }, 'Document returned to downloaded (chunking aborted by stop)');
        return { documentId: doc.id, sourceId: doc.sourceId, status: 'duplicate', durationMs }; // 'duplicate' = skipped in counters
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      docLog.error({ err: errorMsg }, `Pipeline failed for ${doc.sourceId}`);
      await this.updateStatus(doc.id, 'failed', 'pipeline', 'failed', errorMsg);

      // Cascade pipeline failure → review row (if any). Without this,
      // Portal-published docs that fail before review_novelty leave the
      // review stuck in 'pending' indefinitely (worker never runs because
      // the DAG never reaches that step). No-op for arxiv docs without a
      // review row, and never downgrades a 'complete' or already-'failed'
      // row.
      try {
        await markReviewFailed(doc.id, errorMsg.slice(0, 300));
      } catch (cascadeErr) {
        docLog.warn(
          { err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr) },
          'markReviewFailed cascade threw — non-critical, continuing',
        );
      }

      // Mark permanent failures as skip_retry — these won't fix themselves on retry
      const isPermanent = /_exceeded|max_chunks|guard_/.test(errorMsg);
      if (isPermanent) {
        try {
          await query(
            `UPDATE documents SET quality_flags = COALESCE(quality_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ skip_retry: true, skip_reason: errorMsg, skipped_at: new Date().toISOString() }), doc.id],
          );
        } catch { /* non-critical */ }
      }

      // Log LaTeX strip failures for TDD iteration
      if (doc.sourceFormat === 'latex' && item.parsedDocument) {
        try {
          const failDir = process.env.RUNNER_DATA_DIR ?? '.';
          const { appendFile } = await import('node:fs/promises');
          const fragment = item.parsedDocument.sections.slice(0, 3)
            .map((s) => s.content.slice(0, 300)).join('\n---\n');
          await appendFile(
            `${failDir}/strip-failures.jsonl`,
            JSON.stringify({
              timestamp: new Date().toISOString(),
              arxivId: doc.sourceId,
              stage: 'pool-pipeline',
              error: errorMsg,
              fragment: fragment.slice(0, 1000),
            }) + '\n',
          );
        } catch { /* non-critical */ }
      }

      return { documentId: doc.id, sourceId: doc.sourceId, status: 'failed', error: errorMsg, durationMs };
    }
  }

  private async updateStatus(
    docId: string, status: Document['status'], step: string,
    logStatus: ProcessingLogEntry['status'], error?: string,
  ): Promise<void> {
    await this.steps.documentStore.updateStatus(docId, status, {
      step, status: logStatus, timestamp: new Date().toISOString(), ...(error ? { error } : {}),
    });
  }

  updatePipelineRun(entry: ProcessingReport['results'][number]): void {
    if (!this.config.pipelineRunId) return;
    const col = entry.status === 'ready' ? 'docs_processed'
      : entry.status === 'duplicate' ? 'docs_skipped'
      : 'docs_failed';
    query(
      `UPDATE pipeline_runs SET
         ${col} = ${col} + 1,
         total_cost = (SELECT COALESCE(SUM(cost) FILTER (WHERE cost = cost),0) FROM processing_costs
           WHERE created_at >= (SELECT started_at FROM pipeline_runs WHERE id = $1))
       WHERE id = $1`,
      [this.config.pipelineRunId],
    ).catch(() => { /* non-critical */ });
  }

  /** Get current resource pool stats (for monitoring/debugging). */
  poolStats(): ReturnType<ResourcePool['stats']> {
    return this.pool.stats();
  }

  /**
   * Classify an incoming doc's PG chunk state to decide pipeline flow:
   * - 'virgin'  → no chunks in PG: run full route (parse, chunk, embed, index).
   * - 'resume'  → pending_embed / embedded chunks exist: skip parse+chunk,
   *   continue from embed.
   * - 'rerun'   → only indexed (or mixed) chunks exist: operator re-queued
   *   for full reprocessing; delete + run full route.
   *
   * Tier-upgrade override (openarx-hjpg, 2026-05-03): if the persisted
   * chunks were produced under abstract_only and the doc has since been
   * promoted to full tier, force 'rerun' so the body gets parsed instead
   * of resuming on the single abstract chunk. Detection logic in
   * isAbstractTierUpgrade() — kept exported for unit testing.
   */
  private async detectResumeState(
    documentId: string,
    currentTier: 'full' | 'abstract_only',
  ): Promise<ResumeState> {
    const counts = await this.chunkStore.countByStatus(documentId);
    const resumable = counts.pending_embed + counts.embedded + counts.indexed_partial;
    const totalPersisted = resumable + counts.indexed;

    // Probe parser_used only when chunk-count signature matches tier upgrade
    // (avoids one extra query per doc on the hot path).
    if (currentTier === 'full' && totalPersisted === 1) {
      const { rows } = await query<{ parser_used: string | null }>(
        `SELECT parser_used FROM documents WHERE id = $1`,
        [documentId],
      );
      if (isAbstractTierUpgrade(currentTier, totalPersisted, rows[0]?.parser_used ?? null)) {
        return 'rerun';
      }
    }

    if (resumable > 0) return 'resume';
    if (counts.indexed > 0) return 'rerun';
    return 'virgin';
  }

  /**
   * Rebuild a minimal ParsedDocument from documents.structured_content so that
   * resume-mode workers (enrich, index) get a valid object. Falls back to an
   * empty shell if the column is null (shouldn't happen because chunker writes
   * it, but defensive).
   */
  private async reconstructParsedDocument(doc: Document): Promise<ParsedDocument> {
    const { rows } = await query<{ structured_content: Record<string, unknown> | null }>(
      `SELECT structured_content FROM documents WHERE id = $1`,
      [doc.id],
    );
    const sc = rows[0]?.structured_content;
    if (sc && typeof sc === 'object') {
      return {
        title: doc.title,
        abstract: doc.abstract ?? '',
        authors: doc.authors.map((a) => a.name),
        sections: (sc.sections as ParsedDocument['sections']) ?? [],
        references: (sc.references as ParsedDocument['references']) ?? [],
        tables: (sc.tables as ParsedDocument['tables']) ?? [],
        formulas: (sc.formulas as ParsedDocument['formulas']) ?? [],
        parserUsed: (sc.parserUsed as string) ?? 'unknown',
        parseDurationMs: (sc.parseDurationMs as number) ?? 0,
        metadata: {},
      } as unknown as ParsedDocument;
    }
    return {
      title: doc.title,
      abstract: doc.abstract ?? '',
      authors: doc.authors.map((a) => a.name),
      sections: [],
      references: [],
      tables: [],
      formulas: [],
      parserUsed: 'resume_stub',
      parseDurationMs: 0,
      metadata: {},
    } as unknown as ParsedDocument;
  }
}

// ─── Helpers ───

function stepToStatus(stepName: string): Document['status'] | null {
  switch (stepName) {
    case 'parse': return 'parsing';
    case 'chunk': return 'chunking';
    case 'enrich': return 'enriching';
    case 'embed_gemini':
    case 'embed_specter': return 'embedding';
    case 's2_lookup': return null; // Post-index step, no status change
    default: return 'embedding';
  }
}

function toObj(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return data !== undefined ? { data } : {};
}

/**
 * Pure detector for the abstract→full tier upgrade case.
 *
 * abstractChunkWorker (workers.ts) produces exactly one chunk per doc and
 * stamps documents.parser_used = 'abstract_only'. When the enricher later
 * finds a permissive license in an alternative source, the doc's effective
 * tier flips to 'full' but the persisted single abstract chunk would
 * otherwise be reused via the normal resume path — leaving the body
 * un-parsed forever.
 *
 * Returns true when ALL three hold:
 *   - currentTier === 'full'           (caller expects body indexing)
 *   - totalPersistedChunks === 1       (matches abstract chunker contract)
 *   - priorParserUsed === 'abstract_only'
 */
export function isAbstractTierUpgrade(
  currentTier: 'full' | 'abstract_only',
  totalPersistedChunks: number,
  priorParserUsed: string | null | undefined,
): boolean {
  return currentTier === 'full'
    && totalPersistedChunks === 1
    && priorParserUsed === 'abstract_only';
}
