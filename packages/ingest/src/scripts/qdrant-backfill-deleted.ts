/**
 * qdrant-backfill-deleted — one-time script.
 *
 * Sets `deleted: false` in the payload of every Qdrant point in the
 * `chunks` collection that doesn't already have the field. Required by
 * core_soft_delete_spec.md §10.1: the search-side must_not filter (PR4)
 * would otherwise hide every point where `deleted` is unset, which is
 * "the entire pre-feature corpus".
 *
 * Run once on S1 **before** deploying the search filter (PR4). Idempotent
 * — safe to re-run; points that already have `deleted=false` are no-ops
 * in the set_payload call.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx src/scripts/qdrant-backfill-deleted.ts [--dry-run] [--batch N] [--from-offset uuid]
 *
 * Scroll + set_payload per batch. Resume offset is printed on each batch
 * so a interrupted run can be continued via --from-offset.
 *
 * Read-only safety: PG is not touched. Only Qdrant points are mutated,
 * and only their payload `deleted` field.
 */

import { QdrantClient } from '@qdrant/js-client-rest';

interface Args {
  dryRun: boolean;
  batch: number;
  fromOffset: string | undefined;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (name: string, fallback?: string): string | undefined => {
    const i = a.indexOf(name);
    if (i === -1) return fallback;
    return a[i + 1];
  };
  return {
    dryRun: a.includes('--dry-run'),
    batch: parseInt(get('--batch', '500')!, 10),
    fromOffset: get('--from-offset'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const url = process.env.QDRANT_URL ?? 'http://localhost:6333';
  const apiKey = process.env.QDRANT_API_KEY;
  const client = new QdrantClient({ url, ...(apiKey ? { apiKey } : {}) });

  const COLLECTION = 'chunks';

  // Total count, for progress.
  const { count: total } = await client.count(COLLECTION, { exact: true });
  console.log(`[backfill] collection=${COLLECTION} total_points=${total} dry_run=${args.dryRun} batch=${args.batch}`);
  if (args.fromOffset) console.log(`[backfill] resuming from offset=${args.fromOffset}`);

  // Qdrant SDK typing: next_page_offset can be the same pointshape as
  // point id (string/number/Record) when composite; we keep it as-is
  // without coercion and pass it back to scroll unchanged.
  let offset: unknown = args.fromOffset;
  let processed = 0;
  let updated = 0;
  const t0 = Date.now();

  // Filter: only points where `deleted` is unset. Qdrant's is_empty
  // condition catches both "key absent" and "key = null" — ideal for
  // legacy points that predate the field.
  const filterMissingDeleted = {
    must: [{ is_empty: { key: 'deleted' } }],
  };

  while (true) {
    const scroll = await client.scroll(COLLECTION, {
      filter: filterMissingDeleted,
      with_payload: false,
      with_vector: false,
      limit: args.batch,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      offset: offset as any,
    });

    const points = scroll.points;
    if (points.length === 0) {
      console.log(`[backfill] done. processed=${processed} updated=${updated} elapsed_s=${((Date.now() - t0) / 1000).toFixed(1)}`);
      break;
    }

    const ids = points.map((p) => p.id);
    if (!args.dryRun) {
      await client.setPayload(COLLECTION, {
        payload: { deleted: false },
        points: ids,
        wait: true,
      });
      updated += ids.length;
    }
    processed += points.length;

    offset = scroll.next_page_offset ?? undefined;
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '?';
    console.log(
      `[backfill] batch ok points=${points.length} processed=${processed}/${total} (${pct}%) ` +
        `next_offset=${offset ?? '<end>'}`,
    );

    if (offset === undefined || offset === null) {
      console.log(`[backfill] scroll returned null next_page_offset — complete.`);
      break;
    }
  }

  // Verification query — how many points remain without `deleted`?
  if (!args.dryRun) {
    const { count: remaining } = await client.count(COLLECTION, {
      filter: filterMissingDeleted,
      exact: true,
    });
    console.log(`[backfill] verification: points still missing 'deleted' = ${remaining}`);
    if (remaining > 0) {
      console.log(`[backfill] WARNING: ${remaining} points still unset. Re-run the script to finish.`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('[backfill] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
