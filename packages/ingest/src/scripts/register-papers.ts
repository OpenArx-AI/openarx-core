/**
 * Register downloaded arXiv papers into PostgreSQL.
 *
 * Scans local data directory, creates Document records with status 'downloaded'.
 * Idempotent — skips papers already registered.
 *
 * Usage: pnpm --filter @openarx/ingest run register-papers [--limit N]
 */

import { randomUUID } from 'node:crypto';
import { PgDocumentStore, pool } from '@openarx/api';
import type { Document } from '@openarx/types';
import { ArxivLocalAdapter } from '../adapters/arxiv-local.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('register-papers');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

  const adapter = new ArxivLocalAdapter();
  const store = new PgDocumentStore();

  let registered = 0;
  let skipped = 0;

  for await (const raw of adapter.fetch({ mode: 'local', limit })) {
    const existing = await store.getBySourceId('arxiv', raw.sourceId);
    if (existing) {
      log.debug({ sourceId: raw.sourceId }, 'Already registered, skipping');
      skipped++;
      continue;
    }

    const doc: Document = {
      id: randomUUID(),
      version: 1,
      createdAt: new Date(),
      source: 'arxiv',
      sourceId: raw.sourceId,
      sourceUrl: raw.pdfUrl,
      title: raw.title,
      authors: raw.authors,
      abstract: raw.abstract,
      categories: raw.categories,
      publishedAt: raw.publishedAt,
      rawContentPath: raw.pdfPath,
      structuredContent: null,
      codeLinks: [],
      datasetLinks: [],
      benchmarkResults: [],
      status: 'downloaded',
      processingLog: [],
      processingCost: 0,
      provenance: [],
      externalIds: {},
      retryCount: 0,
    };

    await store.save(doc);
    registered++;
    log.info({ sourceId: raw.sourceId, title: raw.title }, 'Registered');
  }

  console.log(`\nDone: ${registered} registered, ${skipped} skipped`);
  await pool.end();
}

main().catch((err) => {
  console.error('Registration failed:', err);
  process.exit(1);
});
