/**
 * migrate-embeddings — one-off migration script for openarx-8og1.
 *
 * Re-embeds every chunk (status IN ('indexed','indexed_partial')) using
 * gemini-embedding-2-preview via the openarx-embed-service, and overwrites
 * the `gemini` named vector in Qdrant (payload + specter2 vector preserved).
 *
 * Resume-safe: marks chunks in PG via chunks.embedding_migrated_at column
 * (migration 024). Restarting the script picks up where it left off.
 *
 * Pre-conditions (see --check-preconditions):
 *   - embed-service reachable
 *   - Runner + enrichment-runner stopped (no concurrent writes to chunks)
 *   - Migration 024 applied (column exists)
 *   - Vertex SA key loaded in embed-service env
 *
 * Usage (examples):
 *   # pre-flight check only
 *   pnpm --filter @openarx/ingest run migrate-embeddings -- --check-preconditions
 *
 *   # dry-run: reads chunks, builds embed inputs, does NOT embed/upsert/mark
 *   pnpm --filter @openarx/ingest run migrate-embeddings -- --dry-run --sample 100
 *
 *   # test run: 1000 chunks into a separate Qdrant collection
 *   pnpm --filter @openarx/ingest run migrate-embeddings -- \
 *     --sample 1000 --target-collection chunks_migration_test
 *
 *   # full run
 *   pnpm --filter @openarx/ingest run migrate-embeddings -- --workers 4 --batch-size 50
 */

import { pool, query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';
import {
  buildEmbedInput,
  splitBatches,
  type MigrationChunkRow,
} from './migrate-embeddings-lib.js';

const log = createChildLogger('migrate-embeddings');

// ─── Config ──────────────────────────────────────────────────

interface Config {
  embedUrls: string[];
  embedSecret: string;
  qdrantUrl: string;
  qdrantApiKey: string;
  targetCollection: string;
  model: string;
  batchSize: number;
  workers: number;
  sample: number | null;
  dryRun: boolean;
  checkOnly: boolean;
  retries: number;
  allowFallback: boolean;
  bypassCache: boolean;
  batchPauseBaseMs: number;
  batchPauseMaxMs: number;
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

  // Multi-server round-robin: comma-separated list. Single URL is the
  // degenerate case and preserves old behaviour.
  const urlsRaw = get('--embed-urls')
    ?? get('--embed-url')
    ?? process.env.EMBED_SERVICE_URL
    ?? 'http://127.0.0.1:3400';
  const embedUrls = urlsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    embedUrls,
    embedSecret: process.env.CORE_INTERNAL_SECRET ?? '',
    qdrantUrl: get('--qdrant-url') ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6335',
    qdrantApiKey: process.env.QDRANT_API_KEY ?? '',
    targetCollection: get('--target-collection') ?? 'chunks',
    model: get('--model') ?? 'gemini-embedding-2-preview',
    batchSize: parseInt(get('--batch-size') ?? '50', 10),
    workers: parseInt(get('--workers') ?? '4', 10),
    sample: get('--sample') ? parseInt(get('--sample')!, 10) : null,
    dryRun: has('--dry-run'),
    checkOnly: has('--check-preconditions'),
    retries: parseInt(get('--retries') ?? '3', 10),
    // Migration runs disable OpenRouter fallback by default — Vertex has
    // bonus credits, OR costs real $. Pass --allow-fallback to override.
    allowFallback: has('--allow-fallback'),
    // Migration texts are unique per chunk, cache hit rate ≈ 0, and
    // pushing ~100GB of short-lived vectors into Redis just evicts warm
    // search entries. Default: bypass cache. Pass --use-cache to override.
    bypassCache: !has('--use-cache'),
    // On persistent failure (after retries), sleep the whole batch before
    // continuing the main loop — gives Google's quota window time to reset.
    batchPauseBaseMs: parseInt(get('--batch-pause-base-ms') ?? '30000', 10),
    batchPauseMaxMs: parseInt(get('--batch-pause-max-ms') ?? '600000', 10),
  };
}

// Local type alias — definitions live in migrate-embeddings-lib.ts
type ChunkRow = MigrationChunkRow;

// ─── HTTP helpers ────────────────────────────────────────────

async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  retries: number,
): Promise<T> {
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

// Global round-robin cursor shared across all concurrent workers so each
// successive POST /embed goes to the next server in rotation.
let embedUrlCursor = 0;

async function callEmbed(
  cfg: Config,
  texts: string[],
): Promise<EmbedResponse> {
  const url = cfg.embedUrls[embedUrlCursor % cfg.embedUrls.length];
  embedUrlCursor++;
  const resp = await fetch(`${url}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': cfg.embedSecret,
    },
    body: JSON.stringify({
      texts,
      model: cfg.model,
      allowFallback: cfg.allowFallback,
      bypassCache: cfg.bypassCache,
    }),
  });
  if (!resp.ok) {
    throw new Error(`embed-service ${url} ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return (await resp.json()) as EmbedResponse;
}

async function upsertQdrantVectors(
  cfg: Config,
  points: Array<{ id: string; vector: number[] }>,
): Promise<void> {
  const body = {
    points: points.map((p) => ({ id: p.id, vector: { gemini: p.vector } })),
  };
  const resp = await fetch(
    `${cfg.qdrantUrl}/collections/${cfg.targetCollection}/points/vectors?wait=true`,
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

  // embed-service reachable — check every URL in round-robin list
  for (const url of cfg.embedUrls) {
    try {
      const r = await fetch(`${url}/health`);
      const h = (await r.json()) as { status?: string; redis?: string; models?: string[] };
      if (h.status !== 'ok') problems.push(`${url} /health status=${h.status}`);
      if (!h.models?.includes(cfg.model)) problems.push(`${url} doesn't know model ${cfg.model}`);
      log.info({ url, health: h }, 'embed-service reachable');
    } catch (err) {
      problems.push(`${url} unreachable: ${(err as Error).message}`);
    }
  }

  if (!cfg.embedSecret) problems.push('CORE_INTERNAL_SECRET env not set');

  // Qdrant reachable + target collection exists
  try {
    const r = await fetch(`${cfg.qdrantUrl}/collections/${cfg.targetCollection}`, {
      headers: { 'api-key': cfg.qdrantApiKey },
    });
    if (!r.ok) {
      problems.push(`qdrant collection ${cfg.targetCollection}: HTTP ${r.status}`);
    } else {
      const d = (await r.json()) as { result?: { config?: { params?: { vectors?: Record<string, { size?: number }> } } } };
      const geminiSize = d.result?.config?.params?.vectors?.gemini?.size;
      if (geminiSize !== 3072) {
        problems.push(`qdrant collection ${cfg.targetCollection} gemini vector size = ${geminiSize}, expected 3072`);
      }
      log.info({ collection: cfg.targetCollection, geminiSize }, 'qdrant collection ok');
    }
  } catch (err) {
    problems.push(`qdrant unreachable: ${(err as Error).message}`);
  }

  // Migration 024 + 025 applied
  try {
    const r = await query<{ has_migrated_at: boolean; has_orphan: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='chunks' AND column_name='embedding_migrated_at') AS has_migrated_at,
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='chunks' AND column_name='qdrant_orphan_detected_at') AS has_orphan`,
    );
    if (!r.rows[0]?.has_migrated_at) {
      problems.push('chunks.embedding_migrated_at column missing — apply migration 024');
    }
    if (!r.rows[0]?.has_orphan) {
      problems.push('chunks.qdrant_orphan_detected_at column missing — apply migration 025');
    }
    if (r.rows[0]?.has_migrated_at && r.rows[0]?.has_orphan) {
      log.info('migrations 024 + 025 applied');
    }
  } catch (err) {
    problems.push(`PG check failed: ${(err as Error).message}`);
  }

  // No runner currently running
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

  // Total work estimate
  try {
    const r = await query<{ total: string; pending: string; orphans: string }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('indexed','indexed_partial'))::text AS total,
         count(*) FILTER (WHERE status IN ('indexed','indexed_partial')
                                AND embedding_migrated_at IS NULL
                                AND qdrant_orphan_detected_at IS NULL)::text AS pending,
         count(*) FILTER (WHERE qdrant_orphan_detected_at IS NOT NULL)::text AS orphans
       FROM chunks`,
    );
    log.info(
      {
        total_in_scope: r.rows[0]?.total,
        pending_migration: r.rows[0]?.pending,
        orphans: r.rows[0]?.orphans,
      },
      'chunks inventory',
    );
  } catch {
    /* already surfaced above if migration not applied */
  }

  if (problems.length > 0) {
    for (const p of problems) log.error(`PRECONDITION FAIL: ${p}`);
    throw new Error(`${problems.length} precondition(s) failed — see logs above`);
  }
  log.info('all preconditions pass');
}

// ─── Worker: process one sub-batch ───────────────────────────

interface BatchStats {
  chunks: number;
  embedMs: number;
  upsertMs: number;
  pgMarkMs: number;
  provider: string;
  inputTokens: number;
  cost: number;
  cacheHits: number;
}

async function processBatch(cfg: Config, rows: ChunkRow[]): Promise<BatchStats> {
  const texts = rows.map(buildEmbedInput);
  const t0 = Date.now();
  const embedResult = await retry(() => callEmbed(cfg, texts), 'embed', cfg.retries);
  const embedMs = Date.now() - t0;

  if (embedResult.vectors.length !== rows.length) {
    throw new Error(`embed returned ${embedResult.vectors.length} vectors for ${rows.length} chunks`);
  }
  for (const v of embedResult.vectors) {
    if (v.length !== 3072) throw new Error(`vector dim ${v.length} != 3072`);
  }

  const points = rows.map((r, i) => ({ id: r.qdrant_point_id, vector: embedResult.vectors[i] }));

  let upsertMs = 0;
  if (!cfg.dryRun) {
    const t1 = Date.now();
    await retry(() => upsertQdrantVectors(cfg, points), 'qdrant', cfg.retries);
    upsertMs = Date.now() - t1;
  }

  // When writing to a non-production collection (e.g. chunks_migration_test)
  // we intentionally skip the PG mark so the same chunks remain eligible for
  // the real migration run. Only the canonical `chunks` collection records
  // migration state in PG.
  const writeToProd = cfg.targetCollection === 'chunks';
  let pgMarkMs = 0;
  if (!cfg.dryRun && writeToProd) {
    const t2 = Date.now();
    await query(
      `UPDATE chunks SET embedding_migrated_at = now() WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    pgMarkMs = Date.now() - t2;
  }

  return {
    chunks: rows.length,
    embedMs,
    upsertMs,
    pgMarkMs,
    provider: embedResult.provider,
    inputTokens: embedResult.inputTokens,
    cost: embedResult.cost,
    cacheHits: embedResult.cached.filter(Boolean).length,
  };
}

// ─── Main loop ───────────────────────────────────────────────

interface Totals {
  processed: number;
  totalCost: number;
  totalInputTokens: number;
  totalErrors: number;
  skipped: number;
  providerCounts: Record<string, number>;
  cacheHits: number;
  startMs: number;
}

async function fetchNextPage(
  cfg: Config,
  sampleRemaining: number | null,
  afterId: string | null,
): Promise<ChunkRow[]> {
  // Page by id ASCENDING for determinism. afterId seeds the cursor so
  // that resumes & parallel workers don't re-read the same rows.
  const pageSize = cfg.batchSize * cfg.workers; // one "big batch"
  const limit = sampleRemaining !== null ? Math.min(pageSize, sampleRemaining) : pageSize;
  const whereCursor = afterId ? 'AND chunks.id > $2::uuid' : '';
  const params: unknown[] = [limit];
  if (afterId) params.push(afterId);
  // Note: select columns are aliased so `ORDER BY chunks.id` sorts by the
  // UUID column (using idx_chunks_embedding_migration_pending) rather than
  // by `id::text` which PG would otherwise interpret as sorting the aliased
  // select list — that forced a full 8.8M-row sort taking ~10s/page.
  //
  // qdrant_orphan_detected_at IS NULL keeps chunks whose point is missing
  // in Qdrant out of the batch — batch-404s from those would fail 49 valid
  // neighbours. They are handled by reindex-orphans in a separate pass.
  const sql = `
    SELECT chunks.id::text AS id,
           chunks.qdrant_point_id::text AS qdrant_point_id,
           chunks.content,
           chunks.context
    FROM chunks
    WHERE chunks.status IN ('indexed','indexed_partial')
      AND chunks.embedding_migrated_at IS NULL
      AND chunks.qdrant_orphan_detected_at IS NULL
      ${whereCursor}
    ORDER BY chunks.id
    LIMIT $1`;
  const r = await query<ChunkRow>(sql, params);
  return r.rows;
}

function logProgress(t: Totals, total: number | null): void {
  const elapsedSec = (Date.now() - t.startMs) / 1000;
  const rate = elapsedSec > 0 ? t.processed / elapsedSec : 0;
  const eta = total && rate > 0 ? (total - t.processed) / rate : null;
  const ratePerMin = rate * 60;
  log.info(
    {
      processed: t.processed,
      total: total ?? 'unknown',
      rate_per_min: Math.round(ratePerMin),
      eta_hours: eta !== null ? (eta / 3600).toFixed(2) : 'n/a',
      cost_usd: t.totalCost.toFixed(4),
      errors: t.totalErrors,
      skipped: t.skipped,
      providers: t.providerCounts,
      cache_hit_rate: t.processed > 0 ? (t.cacheHits / t.processed).toFixed(4) : '0',
    },
    'progress',
  );
}

async function mainLoop(cfg: Config): Promise<void> {
  // Scope total for ETA
  let totalScope: number | null = null;
  {
    const r = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chunks
       WHERE status IN ('indexed','indexed_partial') AND embedding_migrated_at IS NULL`,
    );
    totalScope = parseInt(r.rows[0]?.count ?? '0', 10);
    if (cfg.sample !== null) totalScope = Math.min(totalScope, cfg.sample);
  }

  const writeToProd = cfg.targetCollection === 'chunks';
  log.info(
    {
      model: cfg.model,
      target_collection: cfg.targetCollection,
      workers: cfg.workers,
      batch_size: cfg.batchSize,
      sample: cfg.sample,
      dry_run: cfg.dryRun,
      pg_mark: !cfg.dryRun && writeToProd,
      allow_fallback: cfg.allowFallback,
      bypass_cache: cfg.bypassCache,
      batch_pause_base_ms: cfg.batchPauseBaseMs,
      batch_pause_max_ms: cfg.batchPauseMaxMs,
      total_scope: totalScope,
    },
    'starting migration',
  );

  const totals: Totals = {
    processed: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalErrors: 0,
    skipped: 0,
    providerCounts: {},
    cacheHits: 0,
    startMs: Date.now(),
  };

  let afterId: string | null = null;
  let sampleRemaining = cfg.sample;

  // Back-pressure pause: doubles on each failed big-batch, resets after a
  // fully clean big-batch. Keeps the whole script in lockstep with Google's
  // quota refresh, no in-flight accumulation.
  let batchPauseMs = cfg.batchPauseBaseMs;

  // Graceful shutdown: SIGTERM/SIGINT finish the current big-batch (so
  // Qdrant upserts + PG marks complete atomically), then break the loop.
  // SIGKILL still available for emergencies — script is resume-safe.
  let shutdownRequested = false;
  const onSignal = (sig: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.warn({ signal: sig }, 'graceful shutdown — will exit after current big-batch');
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const progressInterval = setInterval(() => logProgress(totals, totalScope), 30_000);

  try {
    while (true) {
      if (shutdownRequested) {
        log.info('shutdown flag set — exiting main loop cleanly');
        break;
      }
      const page = await fetchNextPage(cfg, sampleRemaining, afterId);
      if (page.length === 0) break;

      afterId = page[page.length - 1].id;
      const subBatches = splitBatches(page, cfg.batchSize);

      const results = await Promise.allSettled(
        subBatches.map((batch) => processBatch(cfg, batch)),
      );

      let anyFailed = false;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const batch = subBatches[i];
        if (r.status === 'fulfilled') {
          totals.processed += r.value.chunks;
          totals.totalCost += r.value.cost;
          totals.totalInputTokens += r.value.inputTokens;
          totals.cacheHits += r.value.cacheHits;
          totals.providerCounts[r.value.provider] = (totals.providerCounts[r.value.provider] ?? 0) + r.value.chunks;
        } else {
          anyFailed = true;
          totals.totalErrors += batch.length;
          log.error(
            { batchSize: batch.length, error: (r.reason as Error).message },
            'sub-batch failed after retries — skipping, embedding_migrated_at stays NULL',
          );
        }
      }

      if (anyFailed) {
        log.warn(
          { pause_ms: batchPauseMs },
          'big-batch had failures — pausing before next fetch to let provider cool down',
        );
        await new Promise((r) => setTimeout(r, batchPauseMs));
        batchPauseMs = Math.min(cfg.batchPauseMaxMs, batchPauseMs * 2);
      } else {
        // Clean big-batch — reset the pause counter
        batchPauseMs = cfg.batchPauseBaseMs;
      }

      if (sampleRemaining !== null) {
        sampleRemaining -= page.length;
        if (sampleRemaining <= 0) break;
      }
    }
  } finally {
    clearInterval(progressInterval);
  }

  const elapsedSec = (Date.now() - totals.startMs) / 1000;
  const rate = elapsedSec > 0 ? totals.processed / elapsedSec : 0;
  log.info(
    {
      processed: totals.processed,
      errors: totals.totalErrors,
      cost_usd: totals.totalCost.toFixed(4),
      input_tokens: totals.totalInputTokens,
      elapsed_seconds: Math.round(elapsedSec),
      rate_per_min: Math.round(rate * 60),
      providers: totals.providerCounts,
      cache_hit_rate: totals.processed > 0 ? (totals.cacheHits / totals.processed).toFixed(4) : '0',
      full_migration_eta_hours: rate > 0 && totalScope ? (8_803_959 / rate / 3600).toFixed(2) : 'n/a',
    },
    'migration complete',
  );
}

// ─── Entry point ─────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseArgs();
  log.info({ cfg: { ...cfg, embedSecret: cfg.embedSecret ? '***' : '', qdrantApiKey: cfg.qdrantApiKey ? '***' : '' } }, 'config');

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
  log.error({ err }, 'migration failed');
  process.exit(1);
});
