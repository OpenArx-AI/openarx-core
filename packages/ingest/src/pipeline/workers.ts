/**
 * Pipeline worker functions.
 *
 * Each worker is a standalone async function that operates on a WorkItem.
 * Workers are pure: they don't know about channels, resource pools, or routing.
 * The orchestrator handles resource acquisition and status transitions.
 *
 * embed is split into embed_gemini and embed_specter for independent
 * resource pool control (specter2 is GPU-bound).
 */

import type {
  Chunk,
  Document,
  DocumentStore,
  ModelRouter,
  ParsedDocument,
  PipelineContext,
  VectorStore,
} from '@openarx/types';
import type { PgChunkStore, EmbedClient } from '@openarx/api';
import {
  query,
  getLatestReview,
  markReviewRunning,
  updateAspect3Fields,
  touchLastSeen,
  appendAuditEntry,
} from '@openarx/api';
import { runNoveltyWorker } from './review/novelty-worker.js';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWithStrategy } from '../parsers/parse-strategy.js';
import { ParserStep } from './parser-step.js';
import { ChunkerStep } from './chunker-step.js';
import { EnricherStep } from './enricher-step.js';
import { IndexerStep } from './indexer-step.js';
import { TranslationStep } from './translation-step.js';
import { computeQualityMetrics } from '../lib/quality-metrics.js';
import { buildStructuredContent } from '../lib/structured-content.js';
import { arxivDocPath } from '../utils/doc-path.js';
import { lookupS2Ids, s2RateLimit } from '../lib/s2-client.js';

// Guards
const GUARD_MAX_CHUNKS = parseInt(process.env.GUARD_MAX_CHUNKS ?? '800', 10);
const GUARD_MAX_COST = parseFloat(process.env.GUARD_MAX_COST ?? '2.00');

// Feature flag: persist chunks to PG immediately after chunking (openarx-q2eh).
// When ON, transient embed/index failures don't waste LLM chunking cost — the
// next retry resumes from loaded-from-PG chunks. When OFF, pipeline behaves
// as before (chunks only hit PG via indexer step).
const PERSIST_CHUNKS_BEFORE_EMBED =
  (process.env.PERSIST_CHUNKS_BEFORE_EMBED ?? 'false').toLowerCase() === 'true';

// ─── WorkItem: mutable state for a document traversing the pipeline ───

export interface WorkItemTiming {
  parseMs: number;
  chunkMs: number;
  enrichMs: number;
  embedGeminiMs: number;
  embedSpecterMs: number;
  indexMs: number;
  totalMs: number;
  translateMs?: number;
  chunkBatches?: number;
  chunkCount?: number;
  enrichCodeLinks?: number;
  enrichDatasets?: number;
  enrichBenchmarks?: number;
}

export interface WorkItem {
  document: Document;
  context: PipelineContext;
  timing: WorkItemTiming;
  startMs: number;

  // Populated by workers
  parsedDocument?: ParsedDocument;
  chunks?: Chunk[];

  // Set by orchestrator when resuming a partially-processed doc (openarx-q2eh):
  // skip parse/translate/chunk + skip enrich if extracted_metadata already set.
  resumed?: boolean;
}

// ─── Steps container (shared across all workers) ───

export interface PipelineSteps {
  documentStore: DocumentStore;
  parserStep: ParserStep;
  chunkerStep: ChunkerStep;
  enricherStep: EnricherStep;
  indexerStep: IndexerStep;
  modelRouter: ModelRouter;
  /** Required: all chunk embeddings (Gemini + SPECTER2) route through
   *  openarx-embed-service via EmbedClient — shared Redis cache and
   *  rate-limiter with the rest of the platform. Direct embedder fallback
   *  has been removed (see openarx-9o0f). */
  embedClient: EmbedClient;
  /** When true, embed-service skips both cache reads and writes for
   *  every chunk-embedding call this run makes. Set per-run via
   *  `openarx ingest --bypass-cache` for backfills (cache hit-rate ≈ 0
   *  on unique chunk text and writes evict warmer search entries). */
  bypassEmbedCache: boolean;
  chunkStore?: PgChunkStore;
  /** Used by reviewNoveltyWorker (Aspect 3) for batched Qdrant neighbour
   *  search. Required when the review_novelty step is present in the
   *  route; the step no-ops for documents without a pending review row. */
  vectorStore?: VectorStore;
}

const INGEST_GEMINI_MODEL = 'gemini-embedding-2-preview' as const;

// ─── Worker type ───

export type WorkerFn = (item: WorkItem, steps: PipelineSteps) => Promise<void>;

// ─── Workers ───

/** Check if a file exists on disk. */
async function fileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try { await access(path); return true; } catch { return false; }
}

const DATA_DIR = process.env.RUNNER_DATA_DIR ?? '/mnt/storagebox/arxiv';

/**
 * Re-download source files from arXiv for a document that has no files on disk.
 * Tries e-print (LaTeX tar.gz) first, then PDF. Updates DB on success.
 * Returns true if at least PDF was downloaded.
 */
async function reDownloadSource(doc: Document, logger: PipelineContext['logger']): Promise<boolean> {
  const arxivId = doc.sourceId;
  const docDir = arxivDocPath(arxivId);
  await mkdir(docDir, { recursive: true });

  let pdfPath = '';
  let sourceFormat = 'pdf';

  // Try PDF
  try {
    const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
    const resp = await fetch(pdfUrl, { signal: AbortSignal.timeout(60_000) });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      pdfPath = join(docDir, 'paper.pdf');
      await writeFile(pdfPath, buf);
      logger.info(`Re-downloaded PDF: ${pdfPath} (${buf.length} bytes)`);
    } else {
      logger.warn(`PDF re-download failed: ${resp.status} ${pdfUrl}`);
      return false;
    }
  } catch (err) {
    logger.warn(`PDF re-download error: ${err instanceof Error ? err.message : err}`);
    return false;
  }

  // Update DB
  const sources: Record<string, unknown> = { pdf: { path: pdfPath, size: 0 } };
  await query(
    `UPDATE documents SET raw_content_path = $1, source_format = $2, sources = $3::jsonb WHERE id = $4`,
    [pdfPath, sourceFormat, JSON.stringify(sources), doc.id],
  );

  // Update in-memory doc
  doc.rawContentPath = pdfPath;
  doc.sourceFormat = sourceFormat as 'pdf' | 'latex';
  (doc as unknown as Record<string, unknown>).sources = sources;

  return true;
}

export async function parseWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { document: doc, context } = item;

  // Dedup check
  const existing = await steps.documentStore.getBySourceId(doc.source, doc.sourceId);

  // Soft-delete: tombstone takes precedence over standard dedup.
  // If a previously-seen document under the same source_id is tombstoned,
  // skip the full pipeline and just refresh last_seen_at + rate-limited
  // audit entry. Upstream still shows the doc but we refuse to re-ingest.
  // (core_soft_delete_spec.md §3.2 / contract §3.)
  if (existing && existing.deletedAt && existing.id !== doc.id) {
    try { await touchLastSeen(existing.id); } catch { /* non-fatal */ }

    // Rate-limit audit writes: spec §4.2 — "only every Nth skip per doc
    // per upstream-source check per week" (we interpret as at most one
    // audit entry per 7 days per tombstoned doc per skipping candidate).
    try {
      const { rows } = await query<{ last: Date | null }>(
        `SELECT MAX(created_at) AS last FROM document_audit_log
         WHERE document_id = $1::uuid AND action = 'ingest_skip'`,
        [existing.id],
      );
      const lastSkip = rows[0]?.last;
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      if (!lastSkip || Date.now() - new Date(lastSkip).getTime() > weekMs) {
        await appendAuditEntry({
          documentId: existing.id,
          action: 'ingest_skip',
          actor: 'ingest-pipeline',
          reason: existing.deletionReason ?? null,
          memo: 'upstream still surfaces this document; re-ingest skipped per tombstone',
          metadata: {
            candidate_doc_id: doc.id,
            source: doc.source,
            source_id: doc.sourceId,
          },
        });
      }
    } catch { /* audit is best-effort */ }

    context.logger.info(
      `ingest_skip: ${doc.sourceId} — tombstoned (reason=${existing.deletionReason}, deleted_at=${existing.deletedAt})`,
    );
    throw new DuplicateError(doc.sourceId);
  }

  if (existing && existing.id !== doc.id && existing.status === 'ready') {
    throw new DuplicateError(doc.sourceId);
  }

  // Pre-parse check: ensure source files exist on disk
  const hasSourceRecord = doc.sources?.pdf?.path || doc.sources?.latex?.path || doc.sources?.markdown?.path;
  const sourcePath = doc.sources?.markdown?.path ?? doc.sources?.latex?.path ?? doc.sources?.pdf?.path ?? doc.rawContentPath ?? '';

  if (!hasSourceRecord || !(await fileExists(sourcePath))) {
    context.logger.warn(`Source files missing for ${doc.sourceId}, attempting re-download...`);
    const ok = await reDownloadSource(doc, context.logger);
    if (!ok) {
      // Permanent failure — mark skip_retry
      await query(
        `UPDATE documents SET quality_flags = COALESCE(quality_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ skip_retry: true, skip_reason: 'source_unavailable_on_arxiv', skipped_at: new Date().toISOString() }), doc.id],
      );
      throw new Error(`Source files unavailable for ${doc.sourceId} — arXiv download failed`);
    }
    // Reload doc from DB to pick up updated sources
    const refreshed = await steps.documentStore.getById(doc.id);
    if (refreshed) {
      item.document = refreshed;
    }
  }

  const t0 = performance.now();
  item.parsedDocument = await parseWithStrategy(item.document, context, steps.parserStep);
  item.timing.parseMs = Math.round(performance.now() - t0);
}

export async function chunkWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { document: doc, context, parsedDocument } = item;
  if (!parsedDocument) throw new Error('No parsedDocument');

  const t0 = performance.now();
  item.chunks = await steps.chunkerStep.process(
    { parsed: parsedDocument, document: doc }, context,
  );
  for (const chunk of item.chunks) {
    chunk.context.documentTitle = doc.title;
  }
  item.timing.chunkMs = Math.round(performance.now() - t0);
  item.timing.chunkCount = item.chunks.length;

  // Guard BEFORE persisting — avoid orphan rows from oversized docs.
  if (item.chunks.length > GUARD_MAX_CHUNKS) {
    throw new Error(`chunks_exceeded: ${item.chunks.length} chunks (limit ${GUARD_MAX_CHUNKS})`);
  }

  // Persist chunks + structured_content immediately so that transient
  // downstream failures (embed/index) don't waste the LLM chunking cost.
  // Feature-flagged during rollout; disabled = legacy behavior.
  if (PERSIST_CHUNKS_BEFORE_EMBED && steps.chunkStore) {
    await steps.chunkStore.insertPendingChunks(item.chunks, doc);
    await query(
      `UPDATE documents SET structured_content = $1 WHERE id = $2 AND structured_content IS NULL`,
      [JSON.stringify(buildStructuredContent(parsedDocument)), doc.id],
    );
    context.logger.debug?.(`Persisted ${item.chunks.length} pending_embed chunks to PG`);
  }
}

export async function enrichWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { document: doc, context, parsedDocument, chunks } = item;
  if (!parsedDocument || !chunks) throw new Error('Missing data for enrich');

  // Resume optimization: if the doc already has extractedMetadata from a
  // previous run, enrichment completed successfully — skip re-running LLM
  // calls + GitHub HEAD requests (rate-limited). Cost guard below still runs.
  const alreadyEnriched =
    item.resumed === true &&
    doc.extractedMetadata &&
    Object.keys(doc.extractedMetadata as Record<string, unknown>).length > 0;

  const t0 = performance.now();
  if (alreadyEnriched) {
    context.logger.info('Skipping enrichment — already completed in prior run');
  } else {
    try {
      const enriched = await steps.enricherStep.process(
        { document: doc, chunks, parsedDocument }, context,
      );
      item.chunks = enriched.chunks;
      item.timing.enrichCodeLinks = doc.codeLinks.length;
      item.timing.enrichDatasets = doc.datasetLinks.length;
      item.timing.enrichBenchmarks = doc.benchmarkResults.length;
    } catch (err) {
      context.logger.warn(`Enrichment failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  item.timing.enrichMs = Math.round(performance.now() - t0);

  // Cost guard
  const costResult = await query<{ total: string }>(
    `SELECT COALESCE(SUM(cost), 0) as total FROM processing_costs WHERE document_id = $1`,
    [doc.id],
  );
  const currentCost = parseFloat(costResult.rows[0]?.total ?? '0');
  if (currentCost > GUARD_MAX_COST) {
    throw new Error(`cost_exceeded: $${currentCost.toFixed(2)} (limit $${GUARD_MAX_COST.toFixed(2)})`);
  }
}

export async function embedGeminiWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { context, chunks } = item;
  if (!chunks || chunks.length === 0) return;

  const { logger, costTracker } = context;

  const texts = chunks.map((chunk) => {
    const title = chunk.context.documentTitle || '';
    const section = chunk.context.sectionPath || chunk.context.sectionName || '';
    if (chunk.context.summary && chunk.context.keyConcept) {
      return `${title}. ${section}. [${chunk.context.keyConcept}] ${chunk.context.summary}\n${chunk.content}`;
    }
    return `${title}. ${section}. ${chunk.content}`;
  });

  logger.info(`Embedding ${chunks.length} chunks with ${INGEST_GEMINI_MODEL} via embed-service${steps.bypassEmbedCache ? ' (bypassCache)' : ''}`);
  const t0 = performance.now();
  const geminiResult = await steps.embedClient.callEmbed(
    texts,
    INGEST_GEMINI_MODEL,
    { bypassCache: steps.bypassEmbedCache },
  );
  const durationMs = Math.round(performance.now() - t0);

  await costTracker.record(
    'embedding-gemini', geminiResult.model, geminiResult.provider ?? 'openrouter',
    geminiResult.inputTokens ?? 0, 0, geminiResult.cost ?? 0, durationMs,
  );

  for (let i = 0; i < chunks.length; i++) {
    chunks[i].vectors.gemini = geminiResult.vectors[i];
  }
  item.timing.embedGeminiMs = durationMs;
  logger.info(`Gemini embedding complete: ${geminiResult.dimensions}d in ${durationMs}ms (provider=${geminiResult.provider})`);
}

/** SPECTER2 embed-service can transiently 502 with "no available SPECTER2
 *  servers (waited Ns, all at capacity or down)" during bursty pool usage.
 *  Retry with jittered exponential backoff before falling through to the
 *  gemini-only safety net (openarx-rth1). */
async function callSpecter2WithRetry(
  client: EmbedClient,
  texts: string[],
  opts: { bypassCache: boolean; logger: PipelineContext['logger']; docId: string },
): ReturnType<EmbedClient['callEmbed']> {
  const MAX_ATTEMPTS = parseInt(process.env.SPECTER2_RETRY_MAX_ATTEMPTS ?? '4', 10);
  const BASE_DELAY_MS = parseInt(process.env.SPECTER2_RETRY_BASE_DELAY_MS ?? '5000', 10);
  const MAX_DELAY_MS = parseInt(process.env.SPECTER2_RETRY_MAX_DELAY_MS ?? '90000', 10);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await client.callEmbed(texts, 'specter2', {
        timeoutMs: 300_000,
        bypassCache: opts.bypassCache,
      });
    } catch (err) {
      lastErr = err;
      if (!isSpecter2Retryable(err) || attempt === MAX_ATTEMPTS) throw err;
      const exp = Math.min(BASE_DELAY_MS * 3 ** (attempt - 1), MAX_DELAY_MS);
      const jitterMs = Math.round(exp * (0.9 + Math.random() * 0.2)); // ±10%
      opts.logger.warn(
        `SPECTER2 transient error (attempt ${attempt}/${MAX_ATTEMPTS}, retry in ${jitterMs}ms, doc=${opts.docId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, jitterMs));
    }
  }
  throw lastErr;
}

/** Errors worth retrying: capacity exhaustion, 5xx, connection-level.
 *  4xx (validation, auth, bad input) → fail fast, retry won't help.
 *  Exported for unit testing. */
export function isSpecter2Retryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // embed-service 502/503/504 (gateway / pool-level)
  if (/embed-service 50[234]/.test(msg)) return true;
  // capacity messaging from embed-service body
  if (/no available .*server|all at capacity|waited \d+s/i.test(msg)) return true;
  // connection-level (already retried by EmbedClient, but defensive)
  if (/ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|network/i.test(msg)) return true;
  return false;
}

export async function embedSpecterWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { context, chunks } = item;
  if (!chunks || chunks.length === 0) return;

  const texts = chunks.map((chunk) => {
    const title = chunk.context.documentTitle || '';
    const section = chunk.context.sectionPath || chunk.context.sectionName || '';
    if (chunk.context.summary && chunk.context.keyConcept) {
      return `${title}. ${section}. [${chunk.context.keyConcept}] ${chunk.context.summary}\n${chunk.content}`;
    }
    return `${title}. ${section}. ${chunk.content}`;
  });

  try {
    context.logger.info(`Embedding ${chunks.length} chunks with SPECTER2 via embed-service${steps.bypassEmbedCache ? ' (bypassCache)' : ''}`);
    const t0 = performance.now();
    // SPECTER2 container is a single-host CPU model that serializes large
    // batches from many parallel pool workers — observed 45-59s p99 latency
    // under a 100-doc run with bursts of 40-128-chunk batches. 300s timeout
    // matches the slowest observed run-to-completion plus headroom.
    //
    // Retry policy (openarx-rth1): pool can be transiently capacity-exhausted
    // during bursty ingest. Wrap call in retry-with-backoff so transient 502s
    // don't drop straight into the gemini-only fallback. Fallback below still
    // catches whatever survives retry exhaustion (rare, by design).
    const specterResult = await callSpecter2WithRetry(steps.embedClient, texts, {
      bypassCache: steps.bypassEmbedCache ?? false,
      logger: context.logger,
      docId: item.document.id,
    });
    const durationMs = Math.round(performance.now() - t0);

    const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
    await context.costTracker.record(
      'embedding-specter2',
      specterResult.model ?? 'allenai/specter2',
      specterResult.provider ?? 'self-hosted',
      specterResult.inputTokens ?? totalChars,
      specterResult.dimensions,
      specterResult.cost ?? 0,
      durationMs,
    );

    for (let i = 0; i < chunks.length; i++) {
      chunks[i].vectors.specter2 = specterResult.vectors[i];
    }
    item.timing.embedSpecterMs = durationMs;
    context.logger.info(`SPECTER2 embedding complete: ${specterResult.dimensions}d in ${durationMs}ms (provider=${specterResult.provider})`);
  } catch (err) {
    // Last-resort fallback after retry exhaustion (openarx-rth1). Doc is
    // indexed gemini-only; doctor reindex-missing-specter2 will fill SPECTER2
    // later for free.
    context.logger.warn(`SPECTER2 unavailable after retries, proceeding Gemini-only: ${err instanceof Error ? err.message : String(err)}`);
    await query(
      `UPDATE documents SET quality_flags = COALESCE(quality_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ missing_specter2: true, specter2_failed_at: new Date().toISOString() }), item.document.id],
    );
  }

  // Transition chunks to 'embedded' once both embedders (or one + fallback)
  // have run. Indexer will move them to 'indexed' or 'indexed_partial'.
  await markEmbeddedIfPersisting(steps, chunks);
}

async function markEmbeddedIfPersisting(steps: PipelineSteps, chunks: Chunk[]): Promise<void> {
  if (!PERSIST_CHUNKS_BEFORE_EMBED || !steps.chunkStore) return;
  await steps.chunkStore.markEmbedded(chunks.map((c) => c.id));
}

export async function indexWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { document: doc, context, parsedDocument, chunks } = item;
  if (!parsedDocument || !chunks) throw new Error('Missing data for index');

  const t0 = performance.now();
  await steps.indexerStep.process(
    { document: doc, chunks, parsedDocument }, context,
  );
  item.timing.indexMs = Math.round(performance.now() - t0);

  // Quality metrics (non-blocking)
  try {
    await computeQualityMetrics(doc.id);
  } catch (err) {
    context.logger.warn(`Quality metrics failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function s2LookupWorker(item: WorkItem, _steps: PipelineSteps): Promise<void> {
  const { document: doc, context } = item;

  // Skip if already enriched
  if (doc.externalIds?.s2_id) return;

  try {
    const ids = await lookupS2Ids(doc.sourceId);
    if (Object.keys(ids).length > 0) {
      const merged = { ...doc.externalIds, ...ids };
      await query(
        'UPDATE documents SET external_ids = $1 WHERE id = $2',
        [JSON.stringify(merged), doc.id],
      );
      doc.externalIds = merged;
      context.logger.info(`S2 lookup: ${Object.keys(ids).join(', ')}`);
    }
    await s2RateLimit();
  } catch (err) {
    // Graceful: don't fail pipeline for S2 issues
    context.logger.warn(`S2 lookup failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Aspect 3 — Novelty + Grounding (Phase 2 content review).
 *
 * Runs post-index so chunks are in Qdrant and retrievable, but before
 * s2_lookup (which is an independent external API call). No-ops for
 * documents that weren't Portal-submitted (no review row); Portal
 * ingests create a pending review row via aspect 1 spam-screen inside
 * POST /ingest-document.
 *
 * Failures are non-blocking per contracts/content_review.md §3: we
 * still mark the review row 'complete' with NULL aspect-3 fields so
 * Portal polling unblocks.
 */
export async function reviewNoveltyWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { document: doc, chunks, parsedDocument, context } = item;

  const existing = await getLatestReview(doc.id);
  if (!existing) {
    // No review row — not a Portal-submitted document. Skip silently.
    return;
  }
  if (existing.status === 'complete' || existing.status === 'failed') {
    // Already resolved (e.g. idempotent re-run); respect prior state.
    return;
  }
  if (!steps.vectorStore) {
    context.logger.warn('review_novelty: vectorStore not configured, skipping');
    await updateAspect3Fields(doc.id, { noveltyScore: null, groundingScore: null, similarDocuments: null });
    return;
  }
  if (!chunks || chunks.length === 0) {
    context.logger.warn('review_novelty: no chunks, marking complete with NULL aspect 3');
    await updateAspect3Fields(doc.id, { noveltyScore: null, groundingScore: null, similarDocuments: null });
    return;
  }

  await markReviewRunning(doc.id);
  try {
    const result = await runNoveltyWorker(
      {
        documentId: doc.id,
        conceptId: doc.conceptId ?? doc.id,
        chunks: chunks.map((c) => ({ vectors: c.vectors })),
        references: parsedDocument?.references ?? [],
      },
      {
        vectorStore: steps.vectorStore,
        pgQuery: async <T = Record<string, unknown>>(sql: string, params: unknown[]) => {
          const r = await query<T extends Record<string, unknown> ? T : Record<string, unknown>>(sql, params);
          return { rows: r.rows as T[] };
        },
        logger: {
          info: (msg, meta) => context.logger.info(msg + (meta ? ` ${JSON.stringify(meta)}` : '')),
          warn: (msg, meta) => context.logger.warn(msg + (meta ? ` ${JSON.stringify(meta)}` : '')),
        },
      },
    );
    await updateAspect3Fields(doc.id, result);
  } catch (err) {
    context.logger.warn(
      `review_novelty failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
    // Non-blocking: caller still needs status transition so Portal polling unblocks.
    try {
      await updateAspect3Fields(doc.id, { noveltyScore: null, groundingScore: null, similarDocuments: null });
    } catch { /* swallow — already logged */ }
  }
}

const translationStep = new TranslationStep();

export async function translateWorker(item: WorkItem, _steps: PipelineSteps): Promise<void> {
  const { document: doc, context, parsedDocument } = item;
  if (!parsedDocument) throw new Error('No parsedDocument for translation');

  const t0 = performance.now();
  const result = await translationStep.process({ document: doc, parsedDocument }, context);
  item.document = result.document;
  item.parsedDocument = result.parsedDocument;
  item.timing.translateMs = Math.round(performance.now() - t0);

  if (result.translated) {
    context.logger.info(`Translation took ${item.timing.translateMs}ms`);
  }
}

/**
 * Abstract-only chunk worker — used by ABSTRACT_ONLY_ROUTE.
 *
 * Skips parsing/chunking entirely. Creates a single chunk from the document's
 * abstract (which is metadata, not file content). The downstream embedder will
 * produce one Gemini + one SPECTER2 vector, and the indexer will store one
 * row in the chunks table and one point in Qdrant.
 *
 * Also populates a minimal parsedDocument so downstream steps (enricher, indexer)
 * that include it in their interface don't break. The actual content is unused
 * by enricher/indexer — they only operate on chunks + document fields.
 */
export async function abstractChunkWorker(item: WorkItem, steps: PipelineSteps): Promise<void> {
  const { document: doc, context } = item;

  const abstract = doc.abstract?.trim();
  if (!abstract) {
    throw new Error('No abstract available for abstract-only indexing');
  }

  const { randomUUID } = await import('node:crypto');

  // Create a single chunk from the abstract with stable qdrantPointId
  item.chunks = [{
    id: randomUUID(),
    version: 1,
    createdAt: new Date(),
    documentId: doc.id,
    content: abstract,
    context: {
      documentTitle: doc.title,
      sectionName: 'Abstract',
      sectionPath: 'Abstract',
      positionInDocument: 0,
      totalChunks: 1,
    },
    vectors: {},
    metrics: {},
    qdrantPointId: randomUUID(),
  }];

  // Set a minimal parsedDocument — enricher/indexer expect the field to exist.
  item.parsedDocument = {
    title: doc.title,
    abstract,
    authors: doc.authors.map((a) => a.name),
    sections: [],
    references: [],
    tables: [],
    formulas: [],
    parserUsed: 'abstract_only',
    parseDurationMs: 0,
    metadata: {},
  } as unknown as ParsedDocument;

  const t0 = performance.now();
  item.timing.chunkMs = Math.round(performance.now() - t0);
  context.logger.info(
    `Abstract-only chunk created: ${abstract.length} chars`,
  );

  context.logger.debug?.(
    `[abstract-chunk] doc=${doc.sourceId} chunk_id=${item.chunks[0]?.id} chars=${abstract.length} license=${doc.license ?? 'null'} tier=${doc.indexingTier ?? 'null'}`,
  );

  // Persist pending chunk (same as chunkWorker — feature-flagged).
  if (PERSIST_CHUNKS_BEFORE_EMBED && steps.chunkStore) {
    await steps.chunkStore.insertPendingChunks(item.chunks, doc);
    await query(
      `UPDATE documents SET structured_content = $1 WHERE id = $2 AND structured_content IS NULL`,
      [JSON.stringify(buildStructuredContent(item.parsedDocument)), doc.id],
    );
  }
}

// ─── Worker registry ───

export const WORKERS: Record<string, WorkerFn> = {
  parse: parseWorker,
  translate: translateWorker,
  chunk: chunkWorker,
  abstract_chunk: abstractChunkWorker,
  enrich: enrichWorker,
  embed_gemini: embedGeminiWorker,
  embed_specter: embedSpecterWorker,
  index: indexWorker,
  review_novelty: reviewNoveltyWorker,
  s2_lookup: s2LookupWorker,
};

// ─── Sentinel errors ───

/** Thrown by parseWorker when document is a duplicate. Not a real failure. */
export class DuplicateError extends Error {
  constructor(sourceId: string) {
    super(`Duplicate: ${sourceId}`);
    this.name = 'DuplicateError';
  }
}
