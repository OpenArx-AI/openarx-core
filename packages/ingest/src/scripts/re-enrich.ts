/**
 * Batch re-enrichment for existing documents.
 *
 * Runs EnricherStep on already-processed documents to populate
 * code_links, dataset_links, and benchmark_results using PwC data + LLM.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run re-enrich              # all ready documents
 *   pnpm --filter @openarx/ingest run re-enrich --limit 5    # test with 5 papers
 *   pnpm --filter @openarx/ingest run re-enrich --id <uuid>  # single document
 */

import {
  PgDocumentStore,
  DefaultModelRouter,
  pool,
  query,
} from '@openarx/api';
import { appendProvenance } from '../lib/provenance.js';
import type {
  Chunk,
  ChunkContext,
  Document,
  ParsedDocument,
  ParsedSection,
  PipelineContext,
} from '@openarx/types';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnricherStep } from '../pipeline/enricher-step.js';
import { PwcLoader } from '../pipeline/enricher/pwc-loader.js';
import { PgCostTracker } from '../pipeline/cost-tracker.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('re-enrich');

interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  context: ChunkContext;
  metrics: Record<string, unknown>;
  position: number | null;
  section_title: string | null;
  section_path: string | null;
}

interface StructuredContent {
  parserUsed: string;
  parseDurationMs: number;
  sections: ParsedSection[];
  references: unknown[];
  tables: Array<{ headers: string[]; rows: string[][]; caption?: string }>;
  formulas: unknown[];
}

function parseArgs(): { limit: number; id?: string } {
  const args = process.argv.slice(2);
  let limit = 9999;
  let id: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--id' && args[i + 1]) {
      id = args[i + 1];
      i++;
    }
  }

  return { limit, id };
}

function reconstructParsedDocument(doc: Document): ParsedDocument {
  const sc = doc.structuredContent as StructuredContent | null;
  return {
    title: doc.title,
    abstract: doc.abstract,
    sections: sc?.sections ?? [],
    references: (sc?.references ?? []) as ParsedDocument['references'],
    tables: (sc?.tables ?? []) as ParsedDocument['tables'],
    formulas: (sc?.formulas ?? []) as ParsedDocument['formulas'],
    parserUsed: sc?.parserUsed ?? 'unknown',
    parseDurationMs: sc?.parseDurationMs ?? 0,
  };
}

async function loadChunks(documentId: string): Promise<Chunk[]> {
  const { rows } = await query<ChunkRow>(
    `SELECT id, document_id, content, context, metrics, position, section_title, section_path
     FROM chunks WHERE document_id = $1
     ORDER BY position ASC NULLS LAST, created_at ASC`,
    [documentId],
  );

  return rows.map((r) => ({
    id: r.id,
    version: 1,
    createdAt: new Date(),
    documentId: r.document_id,
    content: r.content,
    context: {
      ...r.context,
      sectionName: r.section_title ?? r.context.sectionName,
      sectionPath: r.section_path ?? r.context.sectionPath,
      positionInDocument: r.position ?? r.context.positionInDocument ?? 0,
    },
    vectors: {},
    metrics: (r.metrics ?? {}) as Record<string, never>,
  }));
}

async function main(): Promise<void> {
  const { limit, id } = parseArgs();

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    console.error('OPENROUTER_API_KEY is required');
    process.exit(1);
  }

  // ModelRouter — only need LLM (no embedding)
  const modelRouter = new DefaultModelRouter({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openrouterApiKey: openrouterKey,
  });

  // Load PwC dataset
  const pwcPath = resolve(process.cwd(), 'data', 'pwc', 'papers-with-abstracts.json');
  let pwcLoader: PwcLoader | undefined;
  if (existsSync(pwcPath)) {
    pwcLoader = new PwcLoader(pwcPath);
    await pwcLoader.load();
    log.info({ indexed: pwcLoader.size }, 'PwC dataset loaded');
  } else {
    log.warn('PwC dataset not found at %s — will skip PwC lookups', pwcPath);
  }

  const enricherStep = new EnricherStep({ pwcLoader });
  const documentStore = new PgDocumentStore();

  // Fetch documents to re-enrich
  let documents: Document[];
  if (id) {
    const doc = await documentStore.getById(id);
    if (!doc) {
      console.error(`Document not found: ${id}`);
      process.exit(1);
    }
    documents = [doc];
  } else {
    documents = await documentStore.listByStatus('ready', limit);
  }

  console.log(`Re-enriching ${documents.length} documents...\n`);

  let withCode = 0;
  let withDatasets = 0;
  let withBenchmarks = 0;
  let errors = 0;

  const codeBySource = new Map<string, number>();
  const datasetBySource = new Map<string, number>();

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const progress = `[${i + 1}/${documents.length}]`;

    try {
      // Load chunks from PostgreSQL
      const chunks = await loadChunks(doc.id);
      if (chunks.length === 0) {
        log.warn({ sourceId: doc.sourceId }, `${progress} No chunks found, skipping`);
        continue;
      }

      // Reconstruct ParsedDocument from structured_content
      const parsedDocument = reconstructParsedDocument(doc);

      // Create pipeline context
      const costTracker = new PgCostTracker(doc.id);
      const docLog = createChildLogger(`re-enrich:${doc.sourceId}`);
      const context: PipelineContext = {
        documentId: doc.id,
        modelRouter,
        config: {},
        logger: {
          debug: (msg: string, data?: unknown) => docLog.debug(data ?? {}, msg),
          info: (msg: string, data?: unknown) => docLog.info(data ?? {}, msg),
          warn: (msg: string, data?: unknown) => docLog.warn(data ?? {}, msg),
          error: (msg: string, data?: unknown) => docLog.error(data ?? {}, msg),
        },
        costTracker,
      };

      // Run enrichment
      const result = await enricherStep.process(
        { document: doc, chunks, parsedDocument },
        context,
      );

      // Update document in DB
      await query(
        `UPDATE documents
         SET code_links = $1, dataset_links = $2, benchmark_results = $3
         WHERE id = $4`,
        [
          JSON.stringify(result.document.codeLinks),
          JSON.stringify(result.document.datasetLinks),
          JSON.stringify(result.document.benchmarkResults),
          doc.id,
        ],
      );

      await appendProvenance(doc.id, { op: 're-enrich' });

      // Track stats
      const cl = result.document.codeLinks.length;
      const dl = result.document.datasetLinks.length;
      const bl = result.document.benchmarkResults.length;

      if (cl > 0) {
        withCode++;
        for (const link of result.document.codeLinks) {
          const src = link.extractedFrom;
          codeBySource.set(src, (codeBySource.get(src) ?? 0) + 1);
        }
      }
      if (dl > 0) {
        withDatasets++;
        for (const link of result.document.datasetLinks) {
          const src = link.extractedFrom;
          datasetBySource.set(src, (datasetBySource.get(src) ?? 0) + 1);
        }
      }
      if (bl > 0) withBenchmarks++;

      console.log(
        `${progress} ${doc.sourceId}: ${cl} code, ${dl} datasets, ${bl} benchmarks`,
      );
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${progress} ${doc.sourceId}: ERROR — ${msg}`);
    }
  }

  // Print summary
  console.log('\n=== Re-enrichment Summary ===');
  console.log(`Total documents: ${documents.length}`);
  console.log(`With code links: ${withCode} (${pct(withCode, documents.length)})`);
  console.log(`With datasets:   ${withDatasets} (${pct(withDatasets, documents.length)})`);
  console.log(`With benchmarks: ${withBenchmarks} (${pct(withBenchmarks, documents.length)})`);
  console.log(`Errors:          ${errors}`);

  if (codeBySource.size > 0) {
    console.log('\nCode links by source:');
    for (const [src, count] of codeBySource) {
      console.log(`  ${src}: ${count}`);
    }
  }

  if (datasetBySource.size > 0) {
    console.log('\nDataset links by source:');
    for (const [src, count] of datasetBySource) {
      console.log(`  ${src}: ${count}`);
    }
  }

  await pool.end();
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error('Re-enrich failed:', err);
  process.exit(1);
});
