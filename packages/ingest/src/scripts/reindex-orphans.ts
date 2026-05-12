/**
 * reindex-orphans — full reindex for chunks flagged as orphan by
 * scan-qdrant-orphans (openarx-8og1 step B).
 *
 * An "orphan" chunk has valid data in PG (content, context, document) but
 * its qdrant_point_id is missing from the Qdrant `chunks` collection —
 * typically a pipeline race from a long-ago run. The migration script
 * couldn't touch these because Qdrant's vectors-only upsert requires the
 * point to exist. Here we do a full re-index: embed both models + create
 * a point with full payload at the existing qdrant_point_id.
 *
 * Flow per chunk:
 *   1. Build the same embed-input string workers.ts uses
 *   2. Embed via embed-service: both gemini-embedding-2-preview + specter2
 *   3. Qdrant upsert at chunk.qdrant_point_id with full payload (same
 *      shape as QdrantVectorStore.upsertChunks)
 *   4. UPDATE chunks SET embedding_migrated_at = now(),
 *                        qdrant_orphan_detected_at = NULL
 *
 * Scope: ~550 chunks as of 2026-04-19 scan. Rate-limited by embed-service
 * (3800 RPM bucket shared with any concurrent runner traffic).
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run reindex-orphans
 *   pnpm --filter @openarx/ingest run reindex-orphans -- --sample 10
 *   pnpm --filter @openarx/ingest run reindex-orphans -- --check-preconditions
 */

import { pool, query, EmbedClient } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';
import { buildEmbedInput } from './migrate-embeddings-lib.js';

const log = createChildLogger('reindex-orphans');

interface Config {
  embedUrl: string;
  embedSecret: string;
  qdrantUrl: string;
  qdrantApiKey: string;
  collection: string;
  geminiModel: 'gemini-embedding-2-preview';
  sample: number | null;
  checkOnly: boolean;
  concurrency: number;
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
    geminiModel: (get('--gemini-model') ?? 'gemini-embedding-2-preview') as Config['geminiModel'],
    sample: get('--sample') ? parseInt(get('--sample')!, 10) : null,
    checkOnly: has('--check-preconditions'),
    // Conservative: orphans are rare, no need to flood the bucket.
    concurrency: parseInt(get('--concurrency') ?? '4', 10),
  };
}

interface OrphanChunk {
  id: string;
  document_id: string;
  qdrant_point_id: string;
  content: string;
  context: {
    documentTitle?: string;
    sectionPath?: string;
    sectionName?: string;
    summary?: string;
    keyConcept?: string;
    positionInDocument?: number;
    totalChunks?: number;
  };
  is_latest: boolean | null;
  concept_id: string | null;
  doc_version: number | null;
}

async function fetchOrphans(sample: number | null): Promise<OrphanChunk[]> {
  const limit = sample ? `LIMIT ${sample}` : '';
  const r = await query<OrphanChunk>(
    `SELECT
       chunks.id::text AS id,
       chunks.document_id::text AS document_id,
       chunks.qdrant_point_id::text AS qdrant_point_id,
       chunks.content,
       chunks.context,
       chunks.is_latest,
       documents.concept_id::text AS concept_id,
       documents.version AS doc_version
     FROM chunks
     JOIN documents ON documents.id = chunks.document_id
     WHERE chunks.qdrant_orphan_detected_at IS NOT NULL
       AND chunks.embedding_migrated_at IS NULL
     ORDER BY chunks.id
     ${limit}`,
  );
  return r.rows;
}

async function checkPreconditions(cfg: Config): Promise<void> {
  const problems: string[] = [];

  if (!cfg.embedSecret) problems.push('CORE_INTERNAL_SECRET env not set');

  try {
    const r = await fetch(`${cfg.embedUrl}/health`);
    const h = (await r.json()) as { status?: string; models?: string[] };
    if (h.status !== 'ok') problems.push(`embed-service /health status=${h.status}`);
    if (!h.models?.includes(cfg.geminiModel)) problems.push(`embed-service doesn't know ${cfg.geminiModel}`);
    if (!h.models?.includes('specter2')) problems.push(`embed-service doesn't know specter2`);
    log.info({ health: h }, 'embed-service ok');
  } catch (err) {
    problems.push(`embed-service unreachable: ${(err as Error).message}`);
  }

  try {
    const r = await fetch(`${cfg.qdrantUrl}/collections/${cfg.collection}`, {
      headers: { 'api-key': cfg.qdrantApiKey },
    });
    if (!r.ok) problems.push(`qdrant ${cfg.collection}: HTTP ${r.status}`);
    else log.info('qdrant collection ok');
  } catch (err) {
    problems.push(`qdrant unreachable: ${(err as Error).message}`);
  }

  try {
    const r = await query<{ orphans: string; pending: string }>(
      `SELECT
         count(*) FILTER (WHERE qdrant_orphan_detected_at IS NOT NULL AND embedding_migrated_at IS NULL)::text AS pending,
         count(*) FILTER (WHERE qdrant_orphan_detected_at IS NOT NULL)::text AS orphans
       FROM chunks`,
    );
    log.info({ orphans_total: r.rows[0]?.orphans, pending: r.rows[0]?.pending }, 'orphan inventory');
  } catch (err) {
    problems.push(`PG inventory failed: ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    for (const p of problems) log.error(`PRECONDITION FAIL: ${p}`);
    throw new Error(`${problems.length} precondition(s) failed`);
  }
  log.info('preconditions pass');
}

async function qdrantUpsertPoint(
  cfg: Config,
  pointId: string,
  gemini: number[],
  specter2: number[],
  payload: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(
    `${cfg.qdrantUrl}/collections/${cfg.collection}/points?wait=true`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': cfg.qdrantApiKey },
      body: JSON.stringify({
        points: [{
          id: pointId,
          vector: { gemini, specter2 },
          payload,
        }],
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`qdrant upsert ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
}

async function processOrphan(
  cfg: Config,
  embed: EmbedClient,
  chunk: OrphanChunk,
): Promise<void> {
  const text = buildEmbedInput(chunk);

  const [gem, spec] = await Promise.all([
    embed.callEmbed([text], cfg.geminiModel),
    embed.callEmbed([text], 'specter2'),
  ]);
  if (gem.vectors.length !== 1 || gem.vectors[0].length !== 3072) {
    throw new Error(`gemini embed bad shape: ${gem.vectors.length}/${gem.vectors[0]?.length}`);
  }
  if (spec.vectors.length !== 1 || spec.vectors[0].length !== 768) {
    throw new Error(`specter2 embed bad shape: ${spec.vectors.length}/${spec.vectors[0]?.length}`);
  }

  const payload: Record<string, unknown> = {
    chunk_id: chunk.id,
    document_id: chunk.document_id,
    document_title: chunk.context.documentTitle ?? '',
    section_title: chunk.context.sectionName ?? '',
    section_path: chunk.context.sectionPath ?? '',
    position_in_document: chunk.context.positionInDocument,
    total_chunks: chunk.context.totalChunks,
    content: chunk.content,
    is_latest: chunk.is_latest ?? true,
  };
  if (chunk.concept_id) payload.concept_id = chunk.concept_id;
  if (chunk.doc_version) payload.version = chunk.doc_version;

  await qdrantUpsertPoint(cfg, chunk.qdrant_point_id, gem.vectors[0], spec.vectors[0], payload);

  await query(
    `UPDATE chunks
       SET embedding_migrated_at = now(),
           qdrant_orphan_detected_at = NULL
     WHERE id = $1::uuid`,
    [chunk.id],
  );
}

async function mapConcurrent<T>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<void>): Promise<{ ok: number; fail: number; errors: string[] }> {
  const results = { ok: 0, fail: 0, errors: [] as string[] };
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await fn(items[i], i);
        results.ok++;
      } catch (err) {
        results.fail++;
        results.errors.push(`chunk ${(items[i] as OrphanChunk).id}: ${(err as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  log.info({ cfg: { ...cfg, embedSecret: cfg.embedSecret ? '***' : '', qdrantApiKey: cfg.qdrantApiKey ? '***' : '' } }, 'config');

  await checkPreconditions(cfg);
  if (cfg.checkOnly) {
    log.info('--check-preconditions done');
    await pool.end();
    return;
  }

  const orphans = await fetchOrphans(cfg.sample);
  if (orphans.length === 0) {
    log.info('no orphans to reindex');
    await pool.end();
    return;
  }

  log.info({ count: orphans.length }, 'starting reindex');
  const embed = new EmbedClient({ url: cfg.embedUrl, secret: cfg.embedSecret });

  const t0 = Date.now();
  const result = await mapConcurrent(orphans, cfg.concurrency, (c) => processOrphan(cfg, embed, c));
  const elapsed = (Date.now() - t0) / 1000;

  log.info({
    reindexed: result.ok,
    failed: result.fail,
    elapsed_seconds: Math.round(elapsed),
    rate_per_min: Math.round((result.ok / elapsed) * 60),
  }, 'reindex-orphans complete');

  if (result.errors.length > 0) {
    log.warn({ first_errors: result.errors.slice(0, 10), total: result.errors.length }, 'errors');
  }

  await pool.end();
}

main().catch((err) => {
  log.error({ err }, 'reindex failed');
  process.exit(1);
});
