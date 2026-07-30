/**
 * sync-abstract-qdrant-payload — Phase 2 of openarx-3me1.
 *
 * After Phase 1 (PG backfill) has populated chunks.context.contentType for
 * abstract chunks, this script propagates the same two filterable fields
 * into Qdrant payload via SetPayload:
 *   - content_type: 'abstract'
 *   - self_contained: true
 *
 * The summary field is intentionally NOT synced to Qdrant — each chunk has
 * a unique summary, so batching SetPayload (which applies one payload to
 * many points) is not possible for it. Summary stays in PG and is read
 * via hydrateChunkContexts on the search path.
 *
 * Batches by 1000 point_ids per SetPayload HTTP call. Targets chunks that
 * have already been backfilled in PG (contentType='abstract' in chunks.context)
 * so Phase 2 is naturally idempotent and re-runnable.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx \
 *     src/scripts/sync-abstract-qdrant-payload.ts \
 *     [--limit N] [--batch-size N] [--dry-run]
 */

import { pool, query } from '@openarx/api';

interface Args {
  limit: number | null;
  batchSize: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let batchSize = 1000;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') { limit = parseInt(args[++i], 10); }
    else if (a === '--batch-size') { batchSize = parseInt(args[++i], 10); }
    else if (a === '--dry-run') { dryRun = true; }
    else { console.error(`unknown arg: ${a}`); process.exit(1); }
  }
  return { limit, batchSize, dryRun };
}

async function setPayloadBatch(
  qdrantUrl: string,
  apiKey: string,
  pointIds: string[],
): Promise<void> {
  const resp = await fetch(`${qdrantUrl}/collections/chunks/points/payload`, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload: {
        content_type: 'abstract',
        self_contained: true,
      },
      points: pointIds,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Qdrant SetPayload failed status=${resp.status} body=${body.slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const qdrantUrl = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!qdrantUrl || !apiKey) {
    console.error('QDRANT_URL and QDRANT_API_KEY env vars required');
    process.exit(1);
  }

  console.error(`[qdrant-sync] args=${JSON.stringify(args)} qdrant=${qdrantUrl}`);

  let cursor: string | null = null;
  let processed = 0;
  let synced = 0;
  const startedAt = Date.now();

  while (true) {
    if (args.limit !== null && processed >= args.limit) break;

    const batchLimit = args.limit !== null
      ? Math.min(args.batchSize, args.limit - processed)
      : args.batchSize;

    const cursorClause: string = cursor ? `AND c.id > $1::uuid` : '';
    const params: unknown[] = cursor ? [cursor, batchLimit] : [batchLimit];

    const result = await query<{ id: string; qdrant_point_id: string }>(
      `
      SELECT c.id, c.qdrant_point_id
      FROM chunks c
      WHERE c.section_path = 'Abstract'
        AND c.position = 0
        AND (c.context->>'contentType') = 'abstract'
        AND c.is_latest = true
        AND c.qdrant_point_id IS NOT NULL
        ${cursorClause}
      ORDER BY c.id
      LIMIT $${params.length}
      `,
      params,
    );
    const rows = result.rows;

    if (rows.length === 0) {
      console.error('[qdrant-sync] no more rows');
      break;
    }

    const pointIds = rows.map((r: { qdrant_point_id: string }) => r.qdrant_point_id);

    if (args.dryRun) {
      console.error(`[dry-run] would sync ${pointIds.length} points, sample point_id=${pointIds[0]}`);
    } else {
      await setPayloadBatch(qdrantUrl, apiKey, pointIds);
      synced += pointIds.length;
    }

    processed += rows.length;
    cursor = rows[rows.length - 1].id;
    const elapsed = Date.now() - startedAt;
    const rate = processed / (elapsed / 1000);
    console.error(`[qdrant-sync] processed=${processed} synced=${synced} cursor=${cursor} elapsed=${elapsed}ms rate=${rate.toFixed(1)}/s`);
  }

  const totalMs = Date.now() - startedAt;
  console.error(`[qdrant-sync] done. processed=${processed} synced=${synced} total_ms=${totalMs}`);
}

main().catch((err) => {
  console.error('[qdrant-sync] fatal:', err);
  process.exit(1);
}).finally(() => pool.end());
