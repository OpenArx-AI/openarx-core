#!/usr/bin/env node
/**
 * Migrate arXiv document folders from flat to 2-level directory structure.
 *
 * Before: /mnt/storagebox/arxiv/2510.26684/
 * After:  /mnt/storagebox/arxiv/25/10/2510.26684/
 *
 * Safe to re-run: skips already-migrated folders.
 * Use --dry-run to preview without moving.
 */

import { readdir, stat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = process.env.RUNNER_DATA_DIR ?? '/mnt/storagebox/arxiv';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_LOG_INTERVAL = 1000;

function parsePrefix(name: string): { yy: string; mm: string } | null {
  const match = name.match(/^(\d{2})(\d{2})\./);
  return match ? { yy: match[1], mm: match[2] } : null;
}

async function main(): Promise<void> {
  console.log(`Migration: ${DATA_DIR}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('Reading directory...');

  const entries = await readdir(DATA_DIR);
  console.log(`Total entries: ${entries.length}`);

  let moved = 0;
  let skipped = 0;
  let errors = 0;
  let alreadyMigrated = 0;

  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];

    // Skip 2-digit prefix dirs (YY dirs from new structure)
    if (/^\d{2}$/.test(name)) {
      alreadyMigrated++;
      continue;
    }

    const prefix = parsePrefix(name);
    if (!prefix) {
      // Non-standard ID (e.g. old arXiv format) — skip
      skipped++;
      continue;
    }

    const oldPath = join(DATA_DIR, name);
    const newParent = join(DATA_DIR, prefix.yy, prefix.mm);
    const newPath = join(newParent, name);

    // Check if source is actually a directory
    try {
      const st = await stat(oldPath);
      if (!st.isDirectory()) { skipped++; continue; }
    } catch {
      skipped++;
      continue;
    }

    // Check if already moved
    try {
      await stat(newPath);
      // Target exists — already migrated, skip
      alreadyMigrated++;
      continue;
    } catch {
      // Target doesn't exist — proceed with move
    }

    if (DRY_RUN) {
      if (moved < 5) console.log(`  [dry-run] ${oldPath} → ${newPath}`);
      moved++;
    } else {
      try {
        await mkdir(newParent, { recursive: true });
        await rename(oldPath, newPath);
        moved++;
      } catch (err) {
        console.error(`  ERROR: ${oldPath} → ${newPath}: ${err instanceof Error ? err.message : err}`);
        errors++;
      }
    }

    if ((moved + errors) % BATCH_LOG_INTERVAL === 0 && (moved + errors) > 0) {
      console.log(`  Progress: ${moved} moved, ${errors} errors, ${alreadyMigrated} already migrated, ${skipped} skipped (${i + 1}/${entries.length})`);
    }
  }

  console.log('\n=== Migration complete ===');
  console.log(`Moved:            ${moved}`);
  console.log(`Already migrated: ${alreadyMigrated}`);
  console.log(`Skipped:          ${skipped}`);
  console.log(`Errors:           ${errors}`);
  console.log(`Total processed:  ${moved + alreadyMigrated + skipped + errors}`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
