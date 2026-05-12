/**
 * Cleanup orphan paper directories on disk.
 *
 * Finds directories in RUNNER_DATA_DIR that have metadata.json but
 * no corresponding record in the documents table. These are leftovers
 * from failed downloads (404, network errors).
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run cleanup-orphans              # dry run
 *   pnpm --filter @openarx/ingest run cleanup-orphans --delete     # actually delete
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { query, pool } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('cleanup-orphans');
const DATA_DIR = process.env.RUNNER_DATA_DIR ?? '/mnt/storagebox/arxiv';
const DRY_RUN = !process.argv.includes('--delete');

async function main(): Promise<void> {
  // Get all source_ids from DB
  const { rows } = await query<{ source_id: string }>(
    'SELECT DISTINCT source_id FROM documents',
  );
  const dbIds = new Set(rows.map((r) => r.source_id));

  // List directories on disk — supports both flat and 2-level (YY/MM/arxivId) layouts
  const orphans: string[] = [];

  async function scanDir(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const st = await stat(fullPath).catch(() => null);
      if (!st?.isDirectory()) continue;

      // Check if it's a paper dir (has metadata.json)
      const metaPath = join(fullPath, 'metadata.json');
      const hasMeta = await stat(metaPath).then(() => true).catch(() => false);
      if (hasMeta) {
        // It's a paper dir — check if in DB
        if (!dbIds.has(entry)) orphans.push(fullPath);
      } else if (entry.match(/^\d{2}$/)) {
        // 2-level prefix dir (YY or MM) — recurse
        await scanDir(fullPath);
      }
    }
  }

  await scanDir(DATA_DIR);

  log.info({ total: orphans.length, dryRun: DRY_RUN }, 'Orphan directories found');

  if (orphans.length === 0) {
    console.log('No orphan directories found.');
    await pool.end();
    return;
  }

  for (const fullPath of orphans) {
    if (DRY_RUN) {
      console.log(`[dry-run] Would delete: ${fullPath}`);
    } else {
      await rm(fullPath, { recursive: true });
      console.log(`[deleted] ${fullPath}`);
    }
  }

  console.log(`\n${DRY_RUN ? 'Dry run' : 'Deleted'}: ${orphans.length} orphan directories`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
