#!/usr/bin/env node

/**
 * OpenArx CLI — stats, costs, ingest management.
 *
 * Usage:
 *   openarx stats               Document/chunk counts
 *   openarx stats --by-category Count by arXiv category
 *   openarx stats --by-date     Count by publication week
 *   openarx costs               Total processing cost
 *   openarx costs --by-task     Cost breakdown by task
 *   openarx costs --by-model    Cost breakdown by model
 *   openarx costs --period 7d   Costs for last N days
 *   openarx ingest status       Document count per status
 *   openarx ingest run          Process downloaded documents
 *   openarx ingest retry-failed Retry failed documents
 *   openarx dedup [--check]     Show potential duplicate documents
 *   openarx dedup --mark        Mark duplicates with 'duplicate' status
 */

import { pool } from '@openarx/api';
import { stats } from './commands/stats.js';
import { costs } from './commands/costs.js';
import { ingest } from './commands/ingest.js';
import { dedup } from './commands/dedup.js';
import { reprocess } from './commands/reprocess.js';
import { enrichment } from './commands/enrichment.js';

const command = process.argv[2];
const args = process.argv.slice(3);

async function main(): Promise<void> {
  switch (command) {
    case 'stats':
      await stats(args);
      break;
    case 'costs':
      await costs(args);
      break;
    case 'ingest':
      await ingest(args);
      break;
    case 'dedup':
      await dedup(args);
      break;
    case 'reprocess':
      await reprocess(args);
      break;
    case 'enrichment':
      await enrichment(args);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }

  await pool.end();
}

function printUsage(): void {
  console.log(`
OpenArx CLI

Usage:
  openarx stats [--by-category|--by-date]
  openarx costs [--by-task|--by-model] [--period <days>d]
  openarx ingest status|run|retry-failed [--limit N] [--concurrency N]
  openarx dedup [--check|--mark]
  openarx reprocess [--all|--quality-below N|--parser <name>|--source-id <id>] [--dry-run] [--limit N]
  openarx enrichment status|stats|stop
  openarx help
`);
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
