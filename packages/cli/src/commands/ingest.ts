/**
 * openarx ingest — ingest pipeline management.
 *
 * Subcommands:
 *   status       Document count per processing status
 *   run          Process downloaded documents
 *   retry-failed Retry failed documents
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PgDocumentStore,
  QdrantVectorStore,
  DefaultModelRouter,
  EmbedClient,
  pool,
  query,
} from '@openarx/api';
import { PipelineOrchestrator, PwcLoader } from '@openarx/ingest';

export async function ingest(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'status':
      await ingestStatus();
      break;
    case 'run':
      await ingestRun(args.slice(1));
      break;
    case 'retry-failed':
      await ingestRetryFailed(args.slice(1));
      break;
    default:
      console.error(`Unknown ingest subcommand: ${subcommand ?? '(none)'}`);
      console.log('\nUsage: openarx ingest status|run|retry-failed [--limit N] [--concurrency N]');
      process.exit(1);
  }
}

function parseLimit(args: string[]): number {
  const idx = args.indexOf('--limit');
  if (idx >= 0 && args[idx + 1]) {
    return parseInt(args[idx + 1], 10);
  }
  return 100;
}

function parseConcurrency(args: string[]): number {
  const idx = args.indexOf('--concurrency');
  if (idx >= 0 && args[idx + 1]) {
    return Math.max(1, parseInt(args[idx + 1], 10));
  }
  return 1;
}

async function ingestStatus(): Promise<void> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, count(*) as count FROM documents GROUP BY status ORDER BY count DESC`,
  );

  console.log('\n=== Ingest Status ===\n');

  let total = 0;
  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    total += count;
    console.log(`  ${row.status.padEnd(15)} ${count.toLocaleString()}`);
  }
  console.log(`  ${'TOTAL'.padEnd(15)} ${total.toLocaleString()}`);
}

async function createOrchestrator(): Promise<PipelineOrchestrator> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  if (!openrouterKey) {
    console.error('OPENROUTER_API_KEY is required');
    process.exit(1);
  }

  const documentStore = new PgDocumentStore();
  const vectorStore = new QdrantVectorStore();
  const modelRouter = new DefaultModelRouter({
    anthropicApiKey: anthropicKey,
    openrouterApiKey: openrouterKey,
  });

  // All embeddings (Gemini + SPECTER2) go through openarx-embed-service.
  const embedServiceUrl = process.env.EMBED_SERVICE_URL;
  const internalSecret = process.env.CORE_INTERNAL_SECRET;
  if (!embedServiceUrl || !internalSecret) {
    console.error('EMBED_SERVICE_URL and CORE_INTERNAL_SECRET are required');
    process.exit(1);
  }
  const embedClient = new EmbedClient({ url: embedServiceUrl, secret: internalSecret });

  // PwC is optional
  const pwcPath = resolve(process.cwd(), 'data', 'pwc', 'papers-with-abstracts.json');
  let pwcLoader: PwcLoader | undefined;
  if (existsSync(pwcPath)) {
    pwcLoader = new PwcLoader(pwcPath);
    await pwcLoader.load();
  }

  return new PipelineOrchestrator(documentStore, vectorStore, modelRouter, {
    embedClient,
    pwcLoader,
  });
}

async function ingestRun(args: string[]): Promise<void> {
  const limit = parseLimit(args);
  const concurrency = parseConcurrency(args);
  console.log(`Processing downloaded documents (limit: ${limit}, concurrency: ${concurrency})...`);

  const orchestrator = await createOrchestrator();
  const report = await orchestrator.processAll(limit, concurrency);

  printReport(report);
}

async function ingestRetryFailed(args: string[]): Promise<void> {
  const limit = parseLimit(args);
  const concurrency = parseConcurrency(args);
  console.log(`Retrying failed documents (limit: ${limit}, concurrency: ${concurrency})...`);

  const orchestrator = await createOrchestrator();
  const report = await orchestrator.retryFailed(limit, concurrency);

  printReport(report);
}

function printReport(report: { total: number; succeeded: number; failed: number; results: Array<{ sourceId: string; status: string; chunks?: number; error?: string; durationMs: number }> }): void {
  console.log('\n=== Pipeline Report ===');
  console.log(`Total: ${report.total}`);
  console.log(`Succeeded: ${report.succeeded}`);
  console.log(`Failed: ${report.failed}`);

  if (report.results.length > 0) {
    console.log('\nDetails:');
    for (const r of report.results) {
      const icon = r.status === 'ready' ? '+' : 'x';
      const info = r.status === 'ready'
        ? `${r.chunks} chunks, ${(r.durationMs / 1000).toFixed(1)}s`
        : `ERROR: ${r.error}`;
      console.log(`  [${icon}] ${r.sourceId} — ${info}`);
    }
  }
}
