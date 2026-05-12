/**
 * openarx stats — document and chunk counts.
 */

import { query } from '@openarx/api';

export async function stats(args: string[]): Promise<void> {
  if (args.includes('--by-category')) {
    await statsByCategory();
  } else if (args.includes('--by-date')) {
    await statsByDate();
  } else {
    await statsDefault();
  }
}

async function statsDefault(): Promise<void> {
  const docResult = await query<{ status: string; count: string }>(
    `SELECT status, count(*) as count FROM documents GROUP BY status ORDER BY count DESC`,
  );

  const chunkResult = await query<{ count: string }>(
    `SELECT count(*) as count FROM chunks`,
  );

  console.log('\n=== Document Stats ===\n');

  let totalDocs = 0;
  for (const row of docResult.rows) {
    const count = parseInt(row.count, 10);
    totalDocs += count;
    console.log(`  ${row.status.padEnd(15)} ${count.toLocaleString()}`);
  }
  console.log(`  ${'TOTAL'.padEnd(15)} ${totalDocs.toLocaleString()}`);

  const totalChunks = parseInt(chunkResult.rows[0]?.count ?? '0', 10);
  console.log(`\n  Chunks: ${totalChunks.toLocaleString()}`);

  if (totalDocs > 0 && totalChunks > 0) {
    console.log(`  Avg chunks/doc: ${(totalChunks / totalDocs).toFixed(1)}`);
  }
}

async function statsByCategory(): Promise<void> {
  const result = await query<{ cat: string; count: string }>(
    `SELECT unnest(categories) as cat, count(*) as count
     FROM documents
     GROUP BY cat
     ORDER BY count DESC
     LIMIT 30`,
  );

  console.log('\n=== Documents by Category ===\n');
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    console.log(`  ${row.cat.padEnd(20)} ${count.toLocaleString()}`);
  }
}

async function statsByDate(): Promise<void> {
  const result = await query<{ week: string; count: string }>(
    `SELECT date_trunc('week', published_at)::date as week, count(*) as count
     FROM documents
     GROUP BY week
     ORDER BY week DESC
     LIMIT 20`,
  );

  console.log('\n=== Documents by Week ===\n');
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    const week = new Date(row.week).toISOString().slice(0, 10);
    console.log(`  ${week.padEnd(15)} ${count.toLocaleString()}`);
  }
}
