/**
 * Backfill script: set is_latest=true on all existing Qdrant points.
 *
 * Run ONCE after deploying F3 versioning (migration 015).
 * Without this, search returns 0 results because existing points
 * lack the is_latest field and the filter excludes them.
 *
 * Usage: npx tsx packages/api/src/db/backfill-qdrant-versioning.ts
 */

import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION = 'chunks';
const BATCH_SIZE = 100;

async function run(): Promise<void> {
  const client = new QdrantClient({
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
  });

  // First, create payload indexes for new fields (idempotent)
  console.log('Creating payload indexes for versioning fields...');
  const newIndexes: Array<{ field: string; schema: 'keyword' | 'integer' | 'bool' }> = [
    { field: 'is_latest', schema: 'bool' },
    { field: 'concept_id', schema: 'keyword' },
    { field: 'version', schema: 'integer' },
  ];

  for (const { field, schema } of newIndexes) {
    try {
      await client.createPayloadIndex(COLLECTION, {
        field_name: field,
        field_schema: schema,
      });
      console.log(`  [created] ${field} (${schema})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists')) {
        console.log(`  [exists] ${field} (${schema})`);
      } else {
        console.error(`  [error] ${field}: ${message}`);
      }
    }
  }

  // Count total points
  const countResult = await client.count(COLLECTION, { exact: true });
  const total = countResult.count;
  console.log(`\nTotal points in collection: ${total}`);

  // Scroll through all points and set is_latest=true on those missing it
  let offset: string | number | undefined;
  let updated = 0;
  let skipped = 0;

  while (true) {
    const batch = await client.scroll(COLLECTION, {
      limit: BATCH_SIZE,
      offset,
      with_payload: ['is_latest'],
      with_vector: false,
    });

    if (batch.points.length === 0) break;

    // Collect point IDs that need is_latest=true
    const needsUpdate: Array<string | number> = [];
    for (const point of batch.points) {
      const payload = point.payload as Record<string, unknown> | null;
      if (!payload || payload.is_latest === undefined || payload.is_latest === null) {
        needsUpdate.push(point.id);
      } else {
        skipped++;
      }
    }

    if (needsUpdate.length > 0) {
      await client.setPayload(COLLECTION, {
        payload: { is_latest: true },
        points: needsUpdate,
      });
      updated += needsUpdate.length;
    }

    offset = (batch.next_page_offset as string | number | undefined) ?? undefined;
    if (!offset) break;

    if ((updated + skipped) % 10000 === 0) {
      console.log(`  Progress: ${updated + skipped}/${total} (${updated} updated, ${skipped} already set)`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Already set: ${skipped}, Total: ${updated + skipped}`);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
