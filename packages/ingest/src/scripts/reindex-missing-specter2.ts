/**
 * reindex-missing-specter2 — add specter2 named vector to Qdrant points for
 * chunks whose parent document is flagged `quality_flags.missing_specter2`.
 *
 * Background: when a SPECTER2 embedding batch fails during ingest
 * (packages/ingest/src/pipeline/workers.ts:embedSpecterWorker), the document
 * is flagged `missing_specter2: true` and the chunks land in Qdrant with
 * only the `gemini` named vector — search with vectorModel=specter2 misses
 * them entirely.
 *
 * Inventory as of 2026-04-21: 1,077 docs / 50,435 chunks. Most accumulated
 * before commit 3a8dc61 (SPECTER2 pool regression fix) + e8f3fc8 (client
 * timeout 300s).
 *
 * Strategy — vectors-only upsert:
 *   PUT /collections/{c}/points/vectors?wait=true { points: [{ id, vector:{ specter2: [...] }}] }
 *
 * This endpoint adds/replaces ONE named vector without touching payload or
 * other named vectors. Safer than a full upsert (reindex-orphans pattern)
 * which would overwrite gemini vectors + payload from the PG-materialised
 * view, potentially clobbering compliance/enrichment fields that were
 * written to Qdrant after the original ingest.
 *
 * Resume-safe per document: clears `missing_specter2` flag only after the
 * whole doc's chunks have been upserted. A partial-success doc keeps its
 * flag and is retried on the next run (idempotent via Qdrant upsert +
 * embed-service cache).
 *
 * Pre-conditions (see --check-preconditions):
 *   - embed-service reachable (with SPECTER2 pool enabled, see openarx-njaf)
 *   - Qdrant `chunks` collection exists with `specter2` named vector slot
 *   - No runner currently running (avoid racing a fresh ingest)
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run reindex-missing-specter2 -- --check-preconditions
 *   pnpm --filter @openarx/ingest run reindex-missing-specter2 -- --dry-run --sample 5
 *   pnpm --filter @openarx/ingest run reindex-missing-specter2 -- --sample 50
 *   pnpm --filter @openarx/ingest run reindex-missing-specter2 -- --concurrency 4
 */

import { pool, query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';
import {
  buildEmbedInput,
  splitBatches,
  type MigrationChunkRow,
} from './migrate-embeddings-lib.js';

const log = createChildLogger('reindex-missing-specter2');

// ─── Config ──────────────────────────────────────────────────

interface Config {
  embedUrl: string;
  embedSecret: string;
  qdrantUrl: string;
  qdrantApiKey: string;
  collection: string;
  concurrency: number;
  embedBatchSize: number;
  upsertBatchSize: number;
  sample: number | null;
  dryRun: boolean;
  checkOnly: boolean;
  retries: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    const next = args[idx + 1];
    if (next && !next.startsWith('--')) return next;
    return 'true';
  };
  const has = (name: string) => args.includes(name);
  return {
    embedUrl: get('--embed-url') ?? process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
    embedSecret: process.env.CORE_INTERNAL_SECRET ?? '',
    qdrantUrl: get('--qdrant-url') ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6335',
    qdrantApiKey: process.env.QDRANT_API_KEY ?? '',
    collection: get('--collection') ?? 'chunks',
    // Docs are independent — doc-level worker pool. Pool itself is 5 SPECTER2
    // servers × max 1 concurrent per server inside embed-service, so 4-8
    // doc-workers saturate it without queueing backup.
    concurrency: parseInt(get('--concurrency') ?? '4', 10),
    // SPECTER2 service hard cap is 64 papers/request (EmbeddingPool const).
    // Match it so a single doc ≤64 chunks → one pool fetch.
    embedBatchSize: parseInt(get('--embed-batch-size') ?? '64', 10),
    // Qdrant points/vectors accepts large batches; 500 keeps payload JSON
    // well under the default 33 MB body limit (500 × 768 × 8 B ≈ 3 MB).
    upsertBatchSize: parseInt(get('--upsert-batch-size') ?? '500', 10),
    sample: get('--sample') ? parseInt(get('--sample')!, 10) : null,
    dryRun: has('--dry-run'),
    checkOnly: has('--check-preconditions'),
    retries: parseInt(get('--retries') ?? '3', 10),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────

async function retry<T>(fn: () => Promise<T>, label: string, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random());
      log.warn(
        { label, attempt: attempt + 1, delayMs: Math.round(delay), error: (err as Error).message },
        'retryable failure — sleeping',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

interface EmbedResponse {
  vectors: number[][];
  model: string;
  dimensions: number;
  provider: string;
  cached: boolean[];
  inputTokens: number;
  cost: number;
}

async function callEmbedSpecter(cfg: Config, texts: string[]): Promise<EmbedResponse> {
  const resp = await fetch(`${cfg.embedUrl}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': cfg.embedSecret,
    },
    body: JSON.stringify({ texts, model: 'specter2' }),
  });
  if (!resp.ok) {
    throw new Error(`embed-service ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return (await resp.json()) as EmbedResponse;
}

async function upsertSpecterVectors(
  cfg: Config,
  points: Array<{ id: string; vector: number[] }>,
): Promise<void> {
  const body = {
    points: points.map((p) => ({ id: p.id, vector: { specter2: p.vector } })),
  };
  const resp = await fetch(
    `${cfg.qdrantUrl}/collections/${cfg.collection}/points/vectors?wait=true`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'api-key': cfg.qdrantApiKey,
      },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    throw new Error(`qdrant ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = (await resp.json()) as { status?: string; result?: { status?: string } };
  const status = data.result?.status ?? data.status;
  if (status && status !== 'acknowledged' && status !== 'completed') {
    throw new Error(`qdrant upsert unexpected status: ${status}`);
  }
}

// ─── Pre-conditions ──────────────────────────────────────────

async function checkPreconditions(cfg: Config): Promise<void> {
  const problems: string[] = [];

  if (!cfg.embedSecret) problems.push('CORE_INTERNAL_SECRET env not set');

  try {
    const r = await fetch(`${cfg.embedUrl}/health`);
    const h = (await r.json()) as { status?: string; models?: string[] };
    if (h.status !== 'ok') problems.push(`embed-service /health status=${h.status}`);
    if (!h.models?.includes('specter2')) problems.push(`embed-service doesn't know specter2`);
    log.info({ health: h }, 'embed-service ok');
  } catch (err) {
    problems.push(`embed-service unreachable: ${(err as Error).message}`);
  }

  try {
    const r = await fetch(`${cfg.qdrantUrl}/collections/${cfg.collection}`, {
      headers: { 'api-key': cfg.qdrantApiKey },
    });
    if (!r.ok) {
      problems.push(`qdrant collection ${cfg.collection}: HTTP ${r.status}`);
    } else {
      const d = (await r.json()) as {
        result?: { config?: { params?: { vectors?: Record<string, { size?: number }> } } };
      };
      const specterSize = d.result?.config?.params?.vectors?.specter2?.size;
      if (specterSize !== 768) {
        problems.push(`qdrant ${cfg.collection} specter2 vector size = ${specterSize}, expected 768`);
      }
      log.info({ collection: cfg.collection, specterSize }, 'qdrant collection ok');
    }
  } catch (err) {
    problems.push(`qdrant unreachable: ${(err as Error).message}`);
  }

  try {
    const r = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pipeline_runs WHERE status = 'running'`,
    );
    const n = parseInt(r.rows[0]?.count ?? '0', 10);
    if (n > 0) problems.push(`refusing to run while ${n} pipeline_run(s) status=running`);
    else log.info('no active pipeline runs');
  } catch (err) {
    problems.push(`pipeline_runs check failed: ${(err as Error).message}`);
  }

  try {
    const r = await query<{ docs: string; chunks: string }>(
      `SELECT
         count(DISTINCT d.id)::text AS docs,
         count(c.id)::text AS chunks
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
       WHERE d.quality_flags->>'missing_specter2' = 'true'`,
    );
    log.info(
      { docs: r.rows[0]?.docs, chunks: r.rows[0]?.chunks },
      'scope: docs flagged missing_specter2 + their chunks',
    );
  } catch (err) {
    problems.push(`scope query failed: ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    for (const p of problems) log.error(`PRECONDITION FAIL: ${p}`);
    throw new Error(`${problems.length} precondition(s) failed — see logs above`);
  }
  log.info('all preconditions pass');
}

// ─── Per-document worker ─────────────────────────────────────

interface DocStats {
  chunks: number;
  embedMs: number;
  upsertMs: number;
  cacheHits: number;
  provider: string | null;
}

async function fetchDocChunks(documentId: string): Promise<MigrationChunkRow[]> {
  const r = await query<MigrationChunkRow>(
    `SELECT id::text AS id,
            qdrant_point_id::text AS qdrant_point_id,
            content,
            context
     FROM chunks
     WHERE document_id = $1::uuid
     ORDER BY position`,
    [documentId],
  );
  return r.rows;
}

async function clearFlag(documentId: string): Promise<void> {
  // `-` on JSONB drops the named key. Removes both markers set by
  // workers.ts so a future `missing_specter2 = true` query ignores this doc.
  await query(
    `UPDATE documents
       SET quality_flags = quality_flags - 'missing_specter2' - 'specter2_failed_at'
     WHERE id = $1::uuid`,
    [documentId],
  );
}

async function processDoc(cfg: Config, documentId: string): Promise<DocStats> {
  const chunks = await fetchDocChunks(documentId);
  if (chunks.length === 0) {
    log.warn({ documentId }, 'no chunks — clearing flag anyway (stale)');
    if (!cfg.dryRun) await clearFlag(documentId);
    return { chunks: 0, embedMs: 0, upsertMs: 0, cacheHits: 0, provider: null };
  }

  // Skip chunks with missing qdrant_point_id (dangling PG row; scan-qdrant-orphans
  // should have caught these but belt+suspenders — otherwise vectors-only upsert
  // would 404 and fail the whole doc.
  const eligible = chunks.filter((c) => !!c.qdrant_point_id);
  const skipped = chunks.length - eligible.length;
  if (skipped > 0) {
    log.warn({ documentId, skipped }, 'skipping chunks without qdrant_point_id');
  }
  if (eligible.length === 0) {
    return { chunks: 0, embedMs: 0, upsertMs: 0, cacheHits: 0, provider: null };
  }

  const embedBatches = splitBatches(eligible, cfg.embedBatchSize);
  const allVectors: number[][] = [];
  let cacheHits = 0;
  let provider: string | null = null;

  const tEmbed = Date.now();
  for (const batch of embedBatches) {
    const texts = batch.map(buildEmbedInput);
    const resp = await retry(() => callEmbedSpecter(cfg, texts), 'embed', cfg.retries);
    if (resp.vectors.length !== batch.length) {
      throw new Error(`embed returned ${resp.vectors.length} vectors for ${batch.length} chunks`);
    }
    for (const v of resp.vectors) {
      if (v.length !== 768) throw new Error(`specter2 vector dim ${v.length} != 768`);
    }
    allVectors.push(...resp.vectors);
    cacheHits += resp.cached.filter(Boolean).length;
    provider = resp.provider;
  }
  const embedMs = Date.now() - tEmbed;

  let upsertMs = 0;
  if (!cfg.dryRun) {
    const points = eligible.map((c, i) => ({ id: c.qdrant_point_id, vector: allVectors[i] }));
    const tUpsert = Date.now();
    for (const pointBatch of splitBatches(points, cfg.upsertBatchSize)) {
      await retry(() => upsertSpecterVectors(cfg, pointBatch), 'qdrant', cfg.retries);
    }
    upsertMs = Date.now() - tUpsert;

    // Clear flag only after every chunk of the doc is upserted successfully.
    // Any thrown error above leaves the flag intact → resume-safe on retry.
    await clearFlag(documentId);
  }

  return { chunks: eligible.length, embedMs, upsertMs, cacheHits, provider };
}

// ─── Main loop ───────────────────────────────────────────────

interface Totals {
  docsOk: number;
  docsFailed: number;
  chunksProcessed: number;
  cacheHits: number;
  totalEmbedMs: number;
  totalUpsertMs: number;
  startMs: number;
  providerCounts: Record<string, number>;
}

async function fetchDocIds(cfg: Config): Promise<string[]> {
  const limit = cfg.sample ?? null;
  const sql = `
    SELECT id::text AS id
    FROM documents
    WHERE quality_flags->>'missing_specter2' = 'true'
    ORDER BY id
    ${limit !== null ? 'LIMIT $1' : ''}
  `;
  const params = limit !== null ? [limit] : [];
  const r = await query<{ id: string }>(sql, params);
  return r.rows.map((row) => row.id);
}

function logProgress(t: Totals, totalDocs: number): void {
  const elapsedSec = (Date.now() - t.startMs) / 1000;
  const done = t.docsOk + t.docsFailed;
  const rate = elapsedSec > 0 ? done / elapsedSec : 0;
  const eta = totalDocs > 0 && rate > 0 ? (totalDocs - done) / rate : null;
  log.info(
    {
      docs_ok: t.docsOk,
      docs_failed: t.docsFailed,
      docs_remaining: Math.max(0, totalDocs - done),
      chunks_processed: t.chunksProcessed,
      docs_per_min: Math.round(rate * 60),
      eta_minutes: eta !== null ? (eta / 60).toFixed(1) : 'n/a',
      cache_hits: t.cacheHits,
      providers: t.providerCounts,
    },
    'progress',
  );
}

async function mainLoop(cfg: Config): Promise<void> {
  const docIds = await fetchDocIds(cfg);
  if (docIds.length === 0) {
    log.info('no docs with missing_specter2 — nothing to do');
    return;
  }

  log.info(
    {
      docs: docIds.length,
      concurrency: cfg.concurrency,
      embed_batch_size: cfg.embedBatchSize,
      upsert_batch_size: cfg.upsertBatchSize,
      dry_run: cfg.dryRun,
    },
    'starting reindex',
  );

  const totals: Totals = {
    docsOk: 0,
    docsFailed: 0,
    chunksProcessed: 0,
    cacheHits: 0,
    totalEmbedMs: 0,
    totalUpsertMs: 0,
    startMs: Date.now(),
    providerCounts: {},
  };

  let shutdownRequested = false;
  const onSignal = (sig: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.warn({ signal: sig }, 'graceful shutdown — finishing in-flight docs then exiting');
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const progressInterval = setInterval(() => logProgress(totals, docIds.length), 30_000);

  try {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(cfg.concurrency, docIds.length) }, async () => {
      while (true) {
        if (shutdownRequested) return;
        const i = cursor++;
        if (i >= docIds.length) return;
        const docId = docIds[i];
        try {
          const stats = await processDoc(cfg, docId);
          totals.docsOk++;
          totals.chunksProcessed += stats.chunks;
          totals.cacheHits += stats.cacheHits;
          totals.totalEmbedMs += stats.embedMs;
          totals.totalUpsertMs += stats.upsertMs;
          if (stats.provider) {
            totals.providerCounts[stats.provider] = (totals.providerCounts[stats.provider] ?? 0) + 1;
          }
        } catch (err) {
          totals.docsFailed++;
          log.error(
            { docId, error: (err as Error).message },
            'doc failed — flag stays set for retry on next run',
          );
        }
      }
    });
    await Promise.all(workers);
  } finally {
    clearInterval(progressInterval);
  }

  const elapsedSec = (Date.now() - totals.startMs) / 1000;
  log.info(
    {
      docs_ok: totals.docsOk,
      docs_failed: totals.docsFailed,
      chunks_processed: totals.chunksProcessed,
      cache_hits: totals.cacheHits,
      elapsed_seconds: Math.round(elapsedSec),
      docs_per_min: elapsedSec > 0 ? Math.round((totals.docsOk / elapsedSec) * 60) : 0,
      avg_embed_ms_per_doc:
        totals.docsOk > 0 ? Math.round(totals.totalEmbedMs / totals.docsOk) : 0,
      avg_upsert_ms_per_doc:
        totals.docsOk > 0 ? Math.round(totals.totalUpsertMs / totals.docsOk) : 0,
      providers: totals.providerCounts,
    },
    'reindex complete',
  );
}

// ─── Entry point ─────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseArgs();
  log.info(
    {
      cfg: {
        ...cfg,
        embedSecret: cfg.embedSecret ? '***' : '',
        qdrantApiKey: cfg.qdrantApiKey ? '***' : '',
      },
    },
    'config',
  );

  await checkPreconditions(cfg);
  if (cfg.checkOnly) {
    log.info('--check-preconditions done');
    await pool.end();
    return;
  }

  await mainLoop(cfg);
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, 'reindex-missing-specter2 failed');
  process.exit(1);
});
