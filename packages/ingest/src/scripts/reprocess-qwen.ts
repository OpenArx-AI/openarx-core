/**
 * reprocess-qwen — Stage-1 background corpus re-processing (epic openarx-lsqk;
 * contract embedding_qwen_migration.md).
 *
 * For each ready document, per document (resumable via documents.qwen_reembed_at):
 *   1. verbatim-recover each chunk's exact source text (reconstructAndRecover —
 *      experimenter-validated 0-silent-wrong; FAILED keeps the original, never a
 *      silent overwrite);
 *   2. overwrite the recovered text in PG (chunks.content) + the Qdrant payload
 *      (content) — the recovered text is the citation canon;
 *   3. re-embed with qwen (buildEmbedInput over the recovered content) and write the
 *      768-slot (physical Qdrant named-vector still "specter2", now qwen). The gemini
 *      3072 vector is NOT touched.
 *   4. mark chunks.recovery_status + documents.qwen_reembed_at.
 *
 * Source resolution (embedding_qwen_migration §5): recovery runs from the STORED
 * structured_content sections (what the chunker saw — NOT a re-parse, which could
 * drift). Documents with empty stored sections (abstract_only, or full-tier docs whose
 * sections were never persisted, or PDF-with-no-stored-text) get re-embed only
 * (recovery_status='reembed_only'). Rebuilding missing text from eprint is a separate
 * step (kept out of the recovery path to protect the source==batch invariant).
 *
 * AUTONOMOUS · RESUMABLE (per-doc marker) · DECOUPLED (blocks nothing) · FAULT-TOLERANT
 * (retry with backoff; a failed doc keeps qwen_reembed_at NULL and is retried) ·
 * OBSERVABLE (throughput / done-remaining / ETA / cost).
 *
 * Bulk is PROD + Vlad-gated (I7 corpus-chunk canary → scale). This script does NOT run
 * itself; a live smoke of the OpenRouter + Qdrant paths happens in the canary/.7 first.
 *
 * Embed backend (embedding_qwen_migration §1): two interchangeable paths (experimenter
 * cross-cosine 0.99997) selected by presence of --tei-urls / TEI_URLS:
 *   • default        — the S1 embed-service (/embed, qwen via OpenRouter). Fine for the
 *                      OPERATIONAL/new-doc stream; rate-limited + a single S1 hop.
 *   • --tei-urls pool — POST straight to a pool of rented-GPU TEI endpoints (round-robin),
 *                      for the BULK: cheaper per-embedding + scales throughput with GPUs.
 * Both yield the same 768-slot vector; the bulk (TEI) and operational (OpenRouter) vectors
 * stay mutually comparable. TEI has no per-request $ — its cost is GPU-hours (wall-clock ×
 * $/GPU-hr), so cost_usd is 0 on that path; budget is derived from throughput externally.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run reprocess-qwen -- --check-preconditions
 *   pnpm --filter @openarx/ingest run reprocess-qwen -- --dry-run --sample 5
 *   pnpm --filter @openarx/ingest run reprocess-qwen -- --sample 50 --concurrency 4
 *   pnpm --filter @openarx/ingest run reprocess-qwen -- --dry-run --sample 20 --tei-urls http://gpu-a:8080,http://gpu-b:8080
 */

import { pool, query } from '@openarx/api';
import type { ParsedSection } from '@openarx/types';
import { createChildLogger } from '../lib/logger.js';
import { buildEmbedInput, splitBatches, type MigrationChunkContext } from './migrate-embeddings-lib.js';
import { capEmbedInput } from './embed-input-cap.js';
import { reconstructAndRecover, type DocChunk } from '../pipeline/stage1-recovery.js';

const log = createChildLogger('reprocess-qwen');

const QWEN_MODEL = 'qwen3-embedding-8b';
const QWEN_DIM = 768;

// ─── Config ──────────────────────────────────────────────────

interface Config {
  embedUrl: string;
  embedSecret: string;
  /** rented-GPU TEI endpoints (comma-sep --tei-urls / TEI_URLS); non-empty ⇒ bulk TEI path. */
  teiUrls: string[];
  /** optional bearer token for the TEI endpoints (TEI_API_KEY). */
  teiApiKey: string;
  qdrantUrl: string;
  qdrantApiKey: string;
  collection: string;
  concurrency: number;
  embedBatchSize: number;
  upsertBatchSize: number;
  sample: number | null;
  format: string | null;
  dryRun: boolean;
  /** profiling: skip the embed phase (measure fetch+recover only, zero embed cost). */
  skipEmbed: boolean;
  /** allow embed-service to fall back to OpenRouter when the GPU pool is down. Default
   *  FALSE for the bulk (pool-only — never silently spend ~$390 on OpenRouter); pass
   *  --allow-openrouter-fallback for a no-GPU test run. Ignored on the --tei-urls path. */
  allowOpenrouterFallback: boolean;
  checkOnly: boolean;
  retries: number;
  /** cap the embed INPUT to at most this many tokens (0 = no cap). The corpus long tail
   *  (max ~13K tok vs ~316 avg) costs ~40× and throttles the GPU pool; capping the input
   *  (NOT the stored content) collapses the tail. Reversible — re-embed later with any cap. */
  maxEmbedTokens: number;
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
  const has = (name: string): boolean => args.includes(name);
  const teiUrls = (get('--tei-urls') ?? process.env.TEI_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u && u !== 'true');
  // TEI's default --max-client-batch-size is 32; larger batches → HTTP 422. Cap the embed
  // batch on the TEI path (the embed-service path has no such limit).
  const embedBatchSize = Math.min(
    parseInt(get('--embed-batch-size') ?? '64', 10),
    teiUrls.length > 0 ? 32 : Number.MAX_SAFE_INTEGER,
  );
  return {
    embedUrl: get('--embed-url') ?? process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
    embedSecret: process.env.CORE_INTERNAL_SECRET ?? '',
    teiUrls,
    teiApiKey: process.env.TEI_API_KEY ?? '',
    qdrantUrl: get('--qdrant-url') ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6335',
    qdrantApiKey: process.env.QDRANT_API_KEY ?? '',
    collection: get('--collection') ?? 'chunks',
    concurrency: parseInt(get('--concurrency') ?? '4', 10),
    embedBatchSize,
    upsertBatchSize: parseInt(get('--upsert-batch-size') ?? '500', 10),
    sample: get('--sample') ? parseInt(get('--sample')!, 10) : null,
    format: get('--format') ?? null, // optional: restrict to one source_format (latex|pdf|markdown)
    dryRun: has('--dry-run'),
    skipEmbed: has('--skip-embed'),
    allowOpenrouterFallback: has('--allow-openrouter-fallback'),
    checkOnly: has('--check-preconditions'),
    retries: parseInt(get('--retries') ?? '3', 10),
    maxEmbedTokens: parseInt(get('--max-embed-tokens') ?? '0', 10),
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
      log.warn({ label, attempt: attempt + 1, delayMs: Math.round(delay), error: (err as Error).message }, 'retryable failure — sleeping');
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

async function callEmbedQwen(cfg: Config, texts: string[]): Promise<EmbedResponse> {
  const resp = await fetch(`${cfg.embedUrl}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': cfg.embedSecret },
    // bypassCache: each recovered chunk text is unique — cache hit rate ~0, and writing
    // ~100GB of one-shot vectors into the 8GB Redis just evicts warm search entries.
    // allowFallback: the router routes to the GPU pool; when it forbids fallback and the
    // pool is down, embed-service surfaces the error → we retry/pause (resume-safe).
    body: JSON.stringify({ texts, model: QWEN_MODEL, bypassCache: true, allowFallback: cfg.allowOpenrouterFallback }),
  });
  if (!resp.ok) throw new Error(`embed-service ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return (await resp.json()) as EmbedResponse;
}

// Round-robin cursor over the TEI pool. JS is single-threaded, so ++ across concurrent
// workers is race-free; it just spreads batches evenly over the rented GPU endpoints.
let teiCursor = 0;

// Count of embed inputs truncated by --max-embed-tokens (observability; single-threaded ⇒ safe).
let truncatedInputs = 0;

/** Next TEI /v1/embeddings URL from the pool. Accepts either a full `.../v1/embeddings`
 *  URL or a base (`http://host:port`) — the OpenAI-compatible path is appended. */
function nextTeiUrl(cfg: Config): string {
  const base = cfg.teiUrls[teiCursor++ % cfg.teiUrls.length];
  return base.endsWith('/embeddings') ? base : `${base.replace(/\/+$/, '')}/v1/embeddings`;
}

/** L2-normalize in place → unit vector. Returns the input for chaining. */
function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Embed via a rented-GPU TEI endpoint (OpenAI-compatible). TEI returns the native 4096
 *  dims — we take the first 768 (MRL truncation) then L2-renormalize on the client. The
 *  truncate-then-L2 recipe is what the experimenter validated (cross-cosine 0.99997 vs
 *  OpenRouter); server-side truncation would L2-normalize over 4096 and diverge. No
 *  per-request $ (GPU-hours are the cost). Plain text input, no instruction prefix. */
async function callEmbedTei(cfg: Config, texts: string[]): Promise<EmbedResponse> {
  const url = nextTeiUrl(cfg);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.teiApiKey) headers.Authorization = `Bearer ${cfg.teiApiKey}`;
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: QWEN_MODEL, input: texts }) });
  if (!resp.ok) throw new Error(`tei ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { data?: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number } };
  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new Error(`tei returned wrong count (sent=${texts.length}, got=${Array.isArray(data.data) ? data.data.length : 'non-array'})`);
  }
  const vectors = data.data.map((d) => {
    const v = d.embedding;
    if (!Array.isArray(v) || v.length < QWEN_DIM) throw new Error(`tei vector dim ${v?.length ?? 0} < ${QWEN_DIM}`);
    return l2normalize(v.length > QWEN_DIM ? v.slice(0, QWEN_DIM) : v);
  });
  return {
    vectors,
    model: QWEN_MODEL,
    dimensions: QWEN_DIM,
    provider: 'qwen-tei',
    cached: texts.map(() => false),
    inputTokens: data.usage?.prompt_tokens ?? 0,
    cost: 0,
  };
}

/** Dispatch to the TEI pool when configured, else the S1 embed-service. */
function callEmbed(cfg: Config, texts: string[]): Promise<EmbedResponse> {
  return cfg.teiUrls.length > 0 ? callEmbedTei(cfg, texts) : callEmbedQwen(cfg, texts);
}

/** Vectors-only upsert of the 768-slot (physical named-vector "specter2", now qwen).
 *  Does NOT touch the gemini vector or the payload. */
async function upsertQwenVectors(cfg: Config, points: Array<{ id: string; vector: number[] }>): Promise<void> {
  const body = { points: points.map((p) => ({ id: p.id, vector: { specter2: p.vector } })) };
  const resp = await fetch(`${cfg.qdrantUrl}/collections/${cfg.collection}/points/vectors?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.qdrantApiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`qdrant vectors ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { status?: string; result?: { status?: string } };
  const status = data.result?.status ?? data.status;
  if (status && status !== 'acknowledged' && status !== 'completed') {
    throw new Error(`qdrant vectors unexpected status: ${status}`);
  }
}

/** Merge a new `content` into each point's payload (MERGE, not replace — other payload
 *  fields are preserved). Batched via the Qdrant points/batch update API (one set_payload
 *  op per point, since content differs per chunk). */
async function setPayloadContent(cfg: Config, points: Array<{ id: string; content: string }>): Promise<void> {
  if (points.length === 0) return;
  const operations = points.map((p) => ({ set_payload: { points: [p.id], payload: { content: p.content } } }));
  const resp = await fetch(`${cfg.qdrantUrl}/collections/${cfg.collection}/points/batch?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.qdrantApiKey },
    body: JSON.stringify({ operations }),
  });
  if (!resp.ok) throw new Error(`qdrant set-payload ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

// ─── PG helpers ──────────────────────────────────────────────

interface ChunkRow extends DocChunk {
  id: string;
  qdrant_point_id: string | null;
  context: MigrationChunkContext;
}

interface RawChunkRow {
  id: string;
  qdrant_point_id: string | null;
  content: string;
  context: MigrationChunkContext | null;
  position: number;
}

async function fetchDocChunks(documentId: string): Promise<ChunkRow[]> {
  const r = await query<RawChunkRow>(
    `SELECT id::text AS id, qdrant_point_id::text AS qdrant_point_id, content, context, position
     FROM chunks WHERE document_id = $1::uuid ORDER BY position`,
    [documentId],
  );
  return r.rows.map((c) => {
    const ctx = c.context ?? {};
    return {
      id: c.id,
      qdrant_point_id: c.qdrant_point_id,
      content: c.content,
      context: ctx,
      sectionPath: ctx.sectionPath ?? ctx.sectionName ?? '',
      position: c.position,
    };
  });
}

/** The document's STORED parser sections (what the chunker saw). Empty array when
 *  structured_content has no sections (abstract_only / not persisted). */
async function fetchDocSections(documentId: string): Promise<ParsedSection[]> {
  const r = await query<{ sections: ParsedSection[] | null }>(
    `SELECT structured_content->'sections' AS sections FROM documents WHERE id = $1::uuid`,
    [documentId],
  );
  const s = r.rows[0]?.sections;
  return Array.isArray(s) ? s : [];
}

async function markDocDone(documentId: string): Promise<void> {
  await query(`UPDATE documents SET qwen_reembed_at = now() WHERE id = $1::uuid`, [documentId]);
}

/** Batched PG update of chunk.content (only changed) + chunk.recovery_status (all),
 *  via a single UPDATE ... FROM (VALUES ...). */
async function updateChunkRows(
  updates: Array<{ id: string; content: string | null; status: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  updates.forEach((u, i) => {
    const b = i * 3;
    values.push(`($${b + 1}::uuid, $${b + 2}::text, $${b + 3}::text)`);
    params.push(u.id, u.content, u.status);
  });
  // content is COALESCE'd: null means "leave content unchanged" (FAILED / reembed_only).
  await query(
    `UPDATE chunks c
        SET content = COALESCE(v.content, c.content),
            recovery_status = v.status
       FROM (VALUES ${values.join(', ')}) AS v(id, content, status)
      WHERE c.id = v.id`,
    params,
  );
}

// ─── Per-document worker ─────────────────────────────────────

interface DocStats {
  chunks: number;
  recovered: number;
  abbreviated: number;
  failed: number;
  reembedOnly: number;
  cost: number;
  /** phase timing (ms) — retrieval (PG), recovery (CPU/difflib), embed (GPU/network). */
  msFetch: number;
  msRecover: number;
  msEmbed: number;
}

async function processDoc(cfg: Config, documentId: string): Promise<DocStats> {
  const tStart = Date.now();
  const chunks = await fetchDocChunks(documentId);
  if (chunks.length === 0) {
    if (!cfg.dryRun) await markDocDone(documentId);
    return { chunks: 0, recovered: 0, abbreviated: 0, failed: 0, reembedOnly: 0, cost: 0, msFetch: Date.now() - tStart, msRecover: 0, msEmbed: 0 };
  }

  const sections = await fetchDocSections(documentId);
  const tAfterFetch = Date.now();
  const recoveries = sections.length > 0 ? reconstructAndRecover(sections, chunks) : null;
  const resultByChunk = new Map<ChunkRow, string>(); // status per chunk
  const newContentByChunk = new Map<ChunkRow, string | null>(); // non-null = changed content

  let recovered = 0;
  let abbreviated = 0;
  let failed = 0;
  let reembedOnly = 0;

  if (recoveries) {
    for (const { chunk, result } of recoveries) {
      if ((result.status === 'recovered' || result.status === 'abbreviated') && result.text != null) {
        const changed = result.text !== chunk.content;
        resultByChunk.set(chunk, result.status);
        newContentByChunk.set(chunk, changed ? result.text : null);
        if (result.status === 'recovered') recovered++;
        else abbreviated++;
      } else {
        // FAILED: keep the original text, never a silent overwrite.
        resultByChunk.set(chunk, result.method === 'unmatched-section' ? 'failed' : 'failed');
        newContentByChunk.set(chunk, null);
        failed++;
      }
    }
  } else {
    // No stored sections → re-embed only (no recovery available for this doc).
    for (const chunk of chunks) {
      resultByChunk.set(chunk, 'reembed_only');
      newContentByChunk.set(chunk, null);
      reembedOnly++;
    }
  }

  // Effective content per chunk = recovered text where changed, else original.
  const effContent = (c: ChunkRow): string => newContentByChunk.get(c) ?? c.content;
  const tAfterRecover = Date.now();

  // Re-embed (qwen) over the effective content, in batches.
  const eligible = chunks.filter((c) => !!c.qdrant_point_id);
  const embedBatches = splitBatches(eligible, cfg.embedBatchSize);
  const vectorByChunk = new Map<ChunkRow, number[]>();
  let cost = 0;
  if (!cfg.skipEmbed) {
    // ba45: fire a document's batches CONCURRENTLY (not serially) — the profiling showed
    // the bottleneck was serial per-doc embed starving the GPU, not recovery (8ms/doc).
    // Combined with --concurrency doc-workers and the router's per-request fan-out across
    // the GPU pool, this keeps the fleet saturated. Order preserved (each batch owns its
    // chunks); the TeiPool's per-backend concurrency + waitForCapacity provide backpressure.
    const results = await Promise.all(
      embedBatches.map(async (batch) => {
        const texts = batch.map((c) => {
          const capped = capEmbedInput(buildEmbedInput({ id: c.id, qdrant_point_id: c.qdrant_point_id ?? '', content: effContent(c), context: c.context }), cfg.maxEmbedTokens);
          if (capped.truncated) truncatedInputs++;
          return capped.text;
        });
        const resp = await retry(() => callEmbed(cfg, texts), 'embed', cfg.retries);
        if (resp.vectors.length !== batch.length) throw new Error(`embed returned ${resp.vectors.length} for ${batch.length}`);
        return { batch, resp };
      }),
    );
    for (const { batch, resp } of results) {
      for (let i = 0; i < batch.length; i++) {
        const v = resp.vectors[i];
        if (v.length !== QWEN_DIM) throw new Error(`qwen vector dim ${v.length} != ${QWEN_DIM}`);
        vectorByChunk.set(batch[i], v);
      }
      cost += resp.cost;
    }
  }
  const tAfterEmbed = Date.now();

  if (!cfg.dryRun && !cfg.skipEmbed) {
    // 1) Qdrant: qwen vectors (all eligible) + recovered content payloads.
    const vectorPoints = eligible.map((c) => ({ id: c.qdrant_point_id!, vector: vectorByChunk.get(c)! }));
    for (const b of splitBatches(vectorPoints, cfg.upsertBatchSize)) {
      await retry(() => upsertQwenVectors(cfg, b), 'qdrant-vectors', cfg.retries);
    }
    const payloadPoints = eligible
      .filter((c) => newContentByChunk.get(c) != null)
      .map((c) => ({ id: c.qdrant_point_id!, content: newContentByChunk.get(c)! }));
    for (const b of splitBatches(payloadPoints, cfg.upsertBatchSize)) {
      await retry(() => setPayloadContent(cfg, b), 'qdrant-payload', cfg.retries);
    }

    // 2) PG: content (changed) + recovery_status (all).
    const pgUpdates = chunks.map((c) => ({ id: c.id, content: newContentByChunk.get(c) ?? null, status: resultByChunk.get(c) ?? 'reembed_only' }));
    for (const b of splitBatches(pgUpdates, 500)) {
      await retry(() => updateChunkRows(b), 'pg-update', cfg.retries);
    }

    // 3) Mark the doc processed only after every step above succeeded → resume-safe.
    await markDocDone(documentId);
  }

  return {
    chunks: eligible.length, recovered, abbreviated, failed, reembedOnly, cost,
    msFetch: tAfterFetch - tStart, msRecover: tAfterRecover - tAfterFetch, msEmbed: tAfterEmbed - tAfterRecover,
  };
}

// ─── Doc selection + main loop ───────────────────────────────

async function fetchDocIds(cfg: Config): Promise<string[]> {
  const clauses = [`qwen_reembed_at IS NULL`, `status = 'ready'`];
  const params: unknown[] = [];
  if (cfg.format) {
    params.push(cfg.format);
    clauses.push(`source_format = $${params.length}`);
  }
  // format-ordered (latex before pdf) then oldest first — uses the partial index.
  let sql = `SELECT id::text AS id FROM documents WHERE ${clauses.join(' AND ')} ORDER BY source_format, created_at`;
  if (cfg.sample !== null) {
    params.push(cfg.sample);
    sql += ` LIMIT $${params.length}`;
  }
  const r = await query<{ id: string }>(sql, params);
  return r.rows.map((row) => row.id);
}

interface Totals {
  docsOk: number;
  docsFailed: number;
  chunks: number;
  recovered: number;
  abbreviated: number;
  failed: number;
  reembedOnly: number;
  cost: number;
  msFetch: number;
  msRecover: number;
  msEmbed: number;
  startMs: number;
}

function logProgress(t: Totals, totalDocs: number): void {
  const elapsedSec = (Date.now() - t.startMs) / 1000;
  const done = t.docsOk + t.docsFailed;
  const rate = elapsedSec > 0 ? done / elapsedSec : 0;
  const eta = totalDocs > 0 && rate > 0 ? (totalDocs - done) / rate : null;
  const totalChunks = t.recovered + t.abbreviated + t.failed + t.reembedOnly;
  log.info(
    {
      docs_ok: t.docsOk,
      docs_failed: t.docsFailed,
      docs_remaining: Math.max(0, totalDocs - done),
      docs_per_min: Math.round(rate * 60),
      eta_hours: eta !== null ? (eta / 3600).toFixed(1) : 'n/a',
      chunks: t.chunks,
      recovered_pct: totalChunks ? +(100 * t.recovered / totalChunks).toFixed(2) : 0,
      abbreviated: t.abbreviated,
      failed: t.failed,
      reembed_only: t.reembedOnly,
      embed_inputs_truncated: truncatedInputs,
      cost_usd: +t.cost.toFixed(4),
      // per-doc phase split (ms) — where the wall-clock actually goes.
      ms_fetch_avg: t.docsOk ? Math.round(t.msFetch / t.docsOk) : 0,
      ms_recover_avg: t.docsOk ? Math.round(t.msRecover / t.docsOk) : 0,
      ms_embed_avg: t.docsOk ? Math.round(t.msEmbed / t.docsOk) : 0,
    },
    'progress',
  );
}

async function mainLoop(cfg: Config): Promise<void> {
  const docIds = await fetchDocIds(cfg);
  if (docIds.length === 0) {
    log.info('no pending documents (qwen_reembed_at IS NULL) — nothing to do');
    return;
  }
  log.info(
    {
      docs: docIds.length,
      concurrency: cfg.concurrency,
      dry_run: cfg.dryRun,
      format: cfg.format ?? 'all',
      embed: cfg.teiUrls.length > 0 ? `tei-pool(${cfg.teiUrls.length})` : 'embed-service',
    },
    'starting reprocess-qwen',
  );

  const totals: Totals = { docsOk: 0, docsFailed: 0, chunks: 0, recovered: 0, abbreviated: 0, failed: 0, reembedOnly: 0, cost: 0, msFetch: 0, msRecover: 0, msEmbed: 0, startMs: Date.now() };

  let shutdownRequested = false;
  const onSignal = (sig: string): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log.warn({ signal: sig }, 'graceful shutdown — finishing in-flight docs then exiting (resume-safe)');
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
          const s = await processDoc(cfg, docId);
          totals.docsOk++;
          totals.chunks += s.chunks;
          totals.recovered += s.recovered;
          totals.abbreviated += s.abbreviated;
          totals.failed += s.failed;
          totals.reembedOnly += s.reembedOnly;
          totals.cost += s.cost;
          totals.msFetch += s.msFetch;
          totals.msRecover += s.msRecover;
          totals.msEmbed += s.msEmbed;
        } catch (err) {
          totals.docsFailed++;
          log.error({ docId, error: (err as Error).message }, 'doc failed — qwen_reembed_at stays NULL, retried next run');
        }
      }
    });
    await Promise.all(workers);
  } finally {
    clearInterval(progressInterval);
  }
  logProgress(totals, docIds.length);
  log.info('reprocess-qwen complete');
}

// ─── Pre-conditions ──────────────────────────────────────────

async function checkPreconditions(cfg: Config): Promise<void> {
  const problems: string[] = [];

  if (cfg.teiUrls.length > 0) {
    // Bulk TEI path: probe the pool with a tiny embed (validates reachability + dim).
    try {
      const r = await callEmbedTei(cfg, ['precondition probe']);
      if (r.vectors[0]?.length !== QWEN_DIM) problems.push(`tei probe returned dim ${r.vectors[0]?.length}, expected ${QWEN_DIM}`);
      else log.info({ tei_urls: cfg.teiUrls.length, dim: r.vectors[0].length }, 'tei pool ok (qwen present)');
    } catch (err) {
      problems.push(`tei pool unreachable: ${(err as Error).message}`);
    }
  } else {
    if (!cfg.embedSecret) problems.push('CORE_INTERNAL_SECRET env not set');
    try {
      const r = await fetch(`${cfg.embedUrl}/health`);
      const h = (await r.json()) as { status?: string; models?: string[] };
      if (h.status !== 'ok') problems.push(`embed-service /health status=${h.status}`);
      if (!h.models?.includes(QWEN_MODEL)) problems.push(`embed-service does not know ${QWEN_MODEL}`);
      else log.info({ health: h }, 'embed-service ok (qwen present)');
    } catch (err) {
      problems.push(`embed-service unreachable: ${(err as Error).message}`);
    }
  }

  try {
    const r = await fetch(`${cfg.qdrantUrl}/collections/${cfg.collection}`, { headers: { 'api-key': cfg.qdrantApiKey } });
    if (!r.ok) problems.push(`qdrant collection ${cfg.collection}: HTTP ${r.status}`);
    else {
      const d = (await r.json()) as { result?: { config?: { params?: { vectors?: Record<string, { size?: number }> } } } };
      const size = d.result?.config?.params?.vectors?.specter2?.size;
      if (size !== QWEN_DIM) problems.push(`qdrant ${cfg.collection} 768-slot (specter2) size=${size}, expected ${QWEN_DIM}`);
      else log.info({ collection: cfg.collection, slotSize: size }, 'qdrant collection ok (768-slot present)');
    }
  } catch (err) {
    problems.push(`qdrant unreachable: ${(err as Error).message}`);
  }

  try {
    const r = await query<{ n: string }>(`SELECT count(*)::text AS n FROM documents WHERE qwen_reembed_at IS NULL AND status = 'ready'`);
    log.info({ pending_docs: r.rows[0]?.n }, 'scope: documents pending qwen re-embed');
  } catch (err) {
    problems.push(`pending-scope query failed (migration 054 applied?): ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    for (const p of problems) log.error(`PRECONDITION FAIL: ${p}`);
    throw new Error(`${problems.length} precondition(s) failed — see logs`);
  }
  log.info('all preconditions pass');
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
        teiApiKey: cfg.teiApiKey ? '***' : '',
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
  log.error({ err }, 'reprocess-qwen failed');
  process.exit(1);
});
