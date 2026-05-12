/**
 * Backfill external IDs for existing documents via Semantic Scholar API.
 *
 * Looks up each document by arXiv ID and stores DOI, S2 CorpusId, DBLP ID.
 * Rate limited to ~100 req / 5 min (S2 free tier).
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run backfill-ids              # all ready docs
 *   pnpm --filter @openarx/ingest run backfill-ids --limit 50   # first 50
 */

import { query, pool } from '@openarx/api';
import { lookupS2Ids, s2RateLimit } from '../lib/s2-client.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('backfill-ids');

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith('--limit'));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] ?? '99999', 10) : 99999;

  // Find docs without S2 enrichment (no s2_id in external_ids)
  const { rows } = await query<{ id: string; source_id: string; external_ids: Record<string, string> }>(
    `SELECT id, source_id, external_ids
     FROM documents
     WHERE status = 'ready'
       AND (external_ids IS NULL OR external_ids = '{}'::jsonb OR NOT external_ids ? 's2_id')
     ORDER BY created_at
     LIMIT $1`,
    [limit],
  );

  log.info({ total: rows.length, limit }, 'Starting S2 external ID backfill');

  let enriched = 0;
  let skipped = 0;
  let notFound = 0;

  for (let i = 0; i < rows.length; i++) {
    const doc = rows[i];
    const arxivId = doc.source_id;

    const ids = await lookupS2Ids(arxivId);

    if (Object.keys(ids).length === 0) {
      notFound++;
    } else {
      // Merge with existing external_ids
      const merged = { ...doc.external_ids, ...ids, arxiv: arxivId };
      await query(
        'UPDATE documents SET external_ids = $1 WHERE id = $2',
        [JSON.stringify(merged), doc.id],
      );
      enriched++;
    }

    if ((i + 1) % 50 === 0) {
      log.info({ progress: i + 1, total: rows.length, enriched, notFound }, 'Progress');
    }

    await s2RateLimit();
  }

  log.info({ enriched, notFound, skipped, total: rows.length }, 'Backfill complete');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
