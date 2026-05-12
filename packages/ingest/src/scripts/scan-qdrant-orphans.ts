/**
 * scan-qdrant-orphans — identify chunks in PG whose qdrant_point_id is
 * absent from the Qdrant `chunks` collection, mark them via
 * chunks.qdrant_orphan_detected_at = now().
 *
 * Context (openarx-8og1): pipeline race conditions left a small number of
 * chunks indexed in PG but never upserted to Qdrant (observed ~514 /
 * 8.8M = 0.006%). During vectors-only migration, a single missing point
 * in a 50-chunk batch fails the whole batch via Qdrant 404 semantics,
 * so we pre-scan and exclude them. Orphans are later re-indexed from
 * scratch by a separate reindex-orphans pass (not this script).
 *
 * Flow:
 *   For each chunk in chunks WHERE status IN ('indexed','indexed_partial')
 *   AND qdrant_orphan_detected_at IS NULL:
 *     - Batch lookup up to 500 point_ids at a time via Qdrant
 *       POST /collections/chunks/points { ids: [...] }
 *     - Compare returned IDs vs requested. Missing = orphan.
 *     - UPDATE chunks SET qdrant_orphan_detected_at = now() for missing IDs.
 *   Log progress every 30s, final summary at completion.
 *
 * Safe to resume: re-running picks up where it left off (skip rows already
 * marked). Idempotent for chunks that now exist in Qdrant (would not be
 * marked, stay NULL, continue).
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run scan-qdrant-orphans
 *   pnpm --filter @openarx/ingest run scan-qdrant-orphans -- --batch-size 500 --sample 10000
 *   pnpm --filter @openarx/ingest run scan-qdrant-orphans -- --check-preconditions
 */

import { pool, query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('scan-qdrant-orphans');

interface Config {
  qdrantUrl: string;
  qdrantApiKey: string;
  collection: string;
  batchSize: number;
  sample: number | null;
  checkOnly: boolean;
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
    qdrantUrl: get('--qdrant-url') ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6335',
    qdrantApiKey: process.env.QDRANT_API_KEY ?? '',
    collection: get('--collection') ?? 'chunks',
    batchSize: parseInt(get('--batch-size') ?? '500', 10),
    sample: get('--sample') ? parseInt(get('--sample')!, 10) : null,
    checkOnly: has('--check-preconditions'),
  };
}

async function checkPreconditions(cfg: Config): Promise<void> {
  const problems: string[] = [];

  try {
    const r = await fetch(`${cfg.qdrantUrl}/collections/${cfg.collection}`, {
      headers: { 'api-key': cfg.qdrantApiKey },
    });
    if (!r.ok) problems.push(`qdrant ${cfg.collection}: HTTP ${r.status}`);
    else log.info({ collection: cfg.collection }, 'qdrant collection reachable');
  } catch (err) {
    problems.push(`qdrant unreachable: ${(err as Error).message}`);
  }

  try {
    const r = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='chunks' AND column_name='qdrant_orphan_detected_at') AS exists`,
    );
    if (!r.rows[0]?.exists) {
      problems.push('chunks.qdrant_orphan_detected_at missing — apply migration 025');
    } else log.info('migration 025 applied');
  } catch (err) {
    problems.push(`PG check failed: ${(err as Error).message}`);
  }

  try {
    const r = await query<{ total: string; unchecked: string; orphans: string }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('indexed','indexed_partial'))::text AS total,
         count(*) FILTER (WHERE status IN ('indexed','indexed_partial')
                                AND qdrant_orphan_detected_at IS NULL)::text AS unchecked,
         count(*) FILTER (WHERE qdrant_orphan_detected_at IS NOT NULL)::text AS orphans
       FROM chunks`,
    );
    log.info({
      total_in_scope: r.rows[0]?.total,
      not_yet_scanned_or_healthy: r.rows[0]?.unchecked,
      already_flagged_orphans: r.rows[0]?.orphans,
    }, 'chunks inventory');
  } catch {
    /* already surfaced */
  }

  if (problems.length > 0) {
    for (const p of problems) log.error(`PRECONDITION FAIL: ${p}`);
    throw new Error(`${problems.length} precondition(s) failed — see logs`);
  }
  log.info('all preconditions pass');
}

/** Fetch next page of chunks to check. Cursor by chunks.id ASCENDING. */
async function fetchPage(
  afterId: string | null,
  batchSize: number,
): Promise<Array<{ id: string; qdrant_point_id: string }>> {
  const sql = afterId
    ? `SELECT chunks.id::text AS id, chunks.qdrant_point_id::text AS qdrant_point_id
       FROM chunks
       WHERE chunks.status IN ('indexed','indexed_partial')
         AND chunks.qdrant_orphan_detected_at IS NULL
         AND chunks.id > $2::uuid
       ORDER BY chunks.id
       LIMIT $1`
    : `SELECT chunks.id::text AS id, chunks.qdrant_point_id::text AS qdrant_point_id
       FROM chunks
       WHERE chunks.status IN ('indexed','indexed_partial')
         AND chunks.qdrant_orphan_detected_at IS NULL
       ORDER BY chunks.id
       LIMIT $1`;
  const params = afterId ? [batchSize, afterId] : [batchSize];
  const r = await query<{ id: string; qdrant_point_id: string }>(sql, params);
  return r.rows;
}

/** Check point existence in Qdrant. Returns the subset of ids that are
 *  MISSING in the collection. */
async function findMissingInQdrant(
  cfg: Config,
  pointIds: string[],
): Promise<string[]> {
  if (pointIds.length === 0) return [];
  const resp = await fetch(
    `${cfg.qdrantUrl}/collections/${cfg.collection}/points`,
    {
      method: 'POST',
      headers: { 'api-key': cfg.qdrantApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: pointIds, with_payload: false, with_vector: false }),
    },
  );
  if (!resp.ok) {
    throw new Error(`qdrant lookup failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
  }
  const data = (await resp.json()) as { result: Array<{ id: string }> };
  const found = new Set(data.result.map((p) => String(p.id)));
  return pointIds.filter((id) => !found.has(id));
}

async function markOrphans(chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  await query(
    `UPDATE chunks SET qdrant_orphan_detected_at = now() WHERE id = ANY($1::uuid[])`,
    [chunkIds],
  );
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  log.info({ cfg: { ...cfg, qdrantApiKey: cfg.qdrantApiKey ? '***' : '' } }, 'config');

  await checkPreconditions(cfg);
  if (cfg.checkOnly) {
    log.info('--check-preconditions done');
    await pool.end();
    return;
  }

  let afterId: string | null = null;
  let scanned = 0;
  let orphanCount = 0;
  let sampleRemaining = cfg.sample;
  const startMs = Date.now();
  let lastProgressMs = startMs;

  while (true) {
    const fetchLimit = sampleRemaining !== null
      ? Math.min(cfg.batchSize, sampleRemaining)
      : cfg.batchSize;
    const page = await fetchPage(afterId, fetchLimit);
    if (page.length === 0) break;

    afterId = page[page.length - 1].id;

    // Map chunk.id → qdrant_point_id so we know which chunks to flag
    const pointToChunk = new Map<string, string>();
    for (const r of page) pointToChunk.set(r.qdrant_point_id, r.id);

    const missingPointIds = await findMissingInQdrant(cfg, page.map((r) => r.qdrant_point_id));
    const missingChunkIds = missingPointIds
      .map((pid) => pointToChunk.get(pid))
      .filter((x): x is string => !!x);

    await markOrphans(missingChunkIds);

    scanned += page.length;
    orphanCount += missingChunkIds.length;

    if (Date.now() - lastProgressMs >= 30_000) {
      const elapsedSec = (Date.now() - startMs) / 1000;
      const rate = scanned / elapsedSec;
      log.info(
        {
          scanned,
          orphans_found: orphanCount,
          orphan_rate: scanned > 0 ? (orphanCount / scanned).toFixed(5) : '0',
          chunks_per_sec: Math.round(rate),
          elapsed_seconds: Math.round(elapsedSec),
        },
        'progress',
      );
      lastProgressMs = Date.now();
    }

    if (sampleRemaining !== null) {
      sampleRemaining -= page.length;
      if (sampleRemaining <= 0) break;
    }
  }

  const elapsedSec = (Date.now() - startMs) / 1000;
  log.info(
    {
      scanned,
      orphans_found: orphanCount,
      orphan_rate: scanned > 0 ? (orphanCount / scanned).toFixed(5) : '0',
      elapsed_seconds: Math.round(elapsedSec),
      chunks_per_sec: Math.round(scanned / elapsedSec),
    },
    'scan complete',
  );
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, 'scan failed');
  process.exit(1);
});
