/**
 * openarx dedup — detect and manage near-duplicate documents.
 *
 * Usage:
 *   openarx dedup [--check]    Dry run — show potential duplicates
 *   openarx dedup --mark       Mark duplicates with 'duplicate' status
 */

import { query } from '@openarx/api';
import { findDuplicates } from '@openarx/ingest';

export async function dedup(args: string[]): Promise<void> {
  const markMode = args.includes('--mark');
  const threshold = 0.95;

  console.log(`\n=== Duplicate Detection (threshold: ${threshold}) ===\n`);

  const pairs = await findDuplicates(threshold);

  if (pairs.length === 0) {
    console.log('  No duplicates found.\n');
    return;
  }

  console.log(`  Found ${pairs.length} potential duplicate pair(s):\n`);

  for (const pair of pairs) {
    console.log(`  Similarity: ${(pair.similarity * 100).toFixed(1)}%`);
    console.log(`    A: [${pair.docA.status}] ${pair.docA.sourceId} — ${pair.docA.title}`);
    console.log(`    B: [${pair.docB.status}] ${pair.docB.sourceId} — ${pair.docB.title}`);
    console.log();
  }

  if (!markMode) {
    console.log('  Run with --mark to mark duplicates.\n');
    return;
  }

  // Mark duplicates: keep the 'ready'/earlier doc, mark the other as 'duplicate'
  let marked = 0;
  for (const pair of pairs) {
    // Decide which to keep: prefer 'ready', otherwise keep the first (earlier) one
    const keepA =
      pair.docA.status === 'ready' ||
      (pair.docA.status !== 'duplicate' && pair.docB.status !== 'ready');
    const markId = keepA ? pair.docB.id : pair.docA.id;
    const markSourceId = keepA ? pair.docB.sourceId : pair.docA.sourceId;

    // Skip if already marked
    if (
      (keepA && pair.docB.status === 'duplicate') ||
      (!keepA && pair.docA.status === 'duplicate')
    ) {
      continue;
    }

    await query(
      `UPDATE documents SET status = 'duplicate', updated_at = now() WHERE id = $1`,
      [markId],
    );
    console.log(`  Marked ${markSourceId} as duplicate`);
    marked++;
  }

  console.log(`\n  Marked ${marked} document(s) as duplicate.\n`);
}
