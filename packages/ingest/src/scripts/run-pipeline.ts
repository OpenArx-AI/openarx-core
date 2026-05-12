/**
 * CLI entry point for the ingest pipeline.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run pipeline              # process all downloaded
 *   pnpm --filter @openarx/ingest run pipeline --limit 5    # process up to 5
 *   pnpm --filter @openarx/ingest run pipeline --retry      # retry failed
 *   pnpm --filter @openarx/ingest run pipeline --id <uuid>  # process single document
 */

import {
  PgDocumentStore,
  QdrantVectorStore,
  DefaultModelRouter,
  EmbedClient,
  pool,
} from '@openarx/api';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { PwcLoader } from '../pipeline/enricher/pwc-loader.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('run-pipeline');

function parseArgs(): { limit: number; retry: boolean; id?: string } {
  const args = process.argv.slice(2);
  let limit = 100;
  let retry = false;
  let id: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--retry') {
      retry = true;
    } else if (args[i] === '--id' && args[i + 1]) {
      id = args[i + 1];
      i++;
    }
  }

  return { limit, retry, id };
}

async function main(): Promise<void> {
  const { limit, retry, id } = parseArgs();

  // Validate required env vars
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
    log.error('EMBED_SERVICE_URL and CORE_INTERNAL_SECRET are required');
    process.exit(1);
  }
  const embedClient = new EmbedClient({ url: embedServiceUrl, secret: internalSecret });

  // Load PwC dataset if available
  const pwcPath = resolve(process.cwd(), 'data', 'pwc', 'papers-with-abstracts.json');
  let pwcLoader: PwcLoader | undefined;
  if (existsSync(pwcPath)) {
    pwcLoader = new PwcLoader(pwcPath);
    await pwcLoader.load();
    log.info({ indexed: pwcLoader.size }, 'PwC dataset loaded');
  } else {
    log.info('PwC dataset not found — enrichment will skip PwC lookups');
  }

  const orchestrator = new PipelineOrchestrator(
    documentStore,
    vectorStore,
    modelRouter,
    { embedClient, pwcLoader },
  );

  let report;

  if (id) {
    console.log(`Processing single document: ${id}`);
    await orchestrator.processOne(id);
    console.log('Done.');
  } else if (retry) {
    console.log(`Retrying failed documents (limit: ${limit})...`);
    report = await orchestrator.retryFailed(limit);
  } else {
    console.log(`Processing downloaded documents (limit: ${limit})...`);
    report = await orchestrator.processAll(limit);
  }

  if (report) {
    console.log('\n=== Pipeline Report ===');
    console.log(`Total: ${report.total}`);
    console.log(`Succeeded: ${report.succeeded}`);
    console.log(`Failed: ${report.failed}`);
    console.log(`Skipped (dedup): ${report.skipped}`);

    if (report.results.length > 0) {
      console.log('\nDetails:');
      for (const r of report.results) {
        if (r.status === 'ready') {
          console.log(`  ✓ ${r.sourceId} — ${r.chunks} chunks, ${(r.durationMs / 1000).toFixed(1)}s`);
        } else if (r.status === 'duplicate') {
          console.log(`  ⊘ ${r.sourceId} — skipped (duplicate)`);
        } else {
          console.log(`  ✗ ${r.sourceId} — ERROR: ${r.error}`);
        }
      }
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
