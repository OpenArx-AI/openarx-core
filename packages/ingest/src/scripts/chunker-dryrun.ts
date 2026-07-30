/**
 * chunker-dryrun — run the ACTUAL updated ChunkerStep.process() on real heavy
 * LaTeX docs, end-to-end, to confirm the no-schema + direct-pro-retry change has
 * no regression (all sections chunked, meta complete, cost ~v5). READ-ONLY:
 *   - document.id is a SYNTHETIC uuid, so the lone `UPDATE documents SET
 *     extracted_metadata WHERE id=$` inside process() affects 0 rows.
 *   - process() returns Chunk[] in memory; it does NOT write chunks (the indexer
 *     step does that separately and is not invoked here).
 * Exercises the real changed code: hasValidChunkJson gate → pro+schema retry →
 * enforceSectionBoundaries → createChunk → fixChunkBoundaries.
 *
 * Usage (on S1, as openarx, with .env loaded):
 *   pnpm --filter @openarx/ingest exec tsx src/scripts/chunker-dryrun.ts \
 *     --source-ids 2407.01753,2406.16803 [--source-ids ...]
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { query, pool, DefaultModelRouter } from '@openarx/api';
import type { Chunk, Document, PipelineContext } from '@openarx/types';
import { LatexStrategy } from '../parsers/parse-strategy.js';
import { ChunkerStep } from '../pipeline/chunker-step.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('chunker-dryrun');

interface CostRow { task: string; model: string; cost: number; inTok: number; outTok: number; ms: number; }

function parseArgs(): string[] {
  const a = process.argv.slice(2);
  const i = a.indexOf('--source-ids');
  const ids = i === -1 ? '' : (a[i + 1] ?? '');
  return ids.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const ids = parseArgs();
  if (ids.length === 0) { console.error('pass --source-ids a,b,c'); process.exit(1); }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const openrouterApiKey = process.env.OPENROUTER_API_KEY ?? '';
  const googleAiApiKey = process.env.GOOGLE_AI_API_KEY;
  if (!googleAiApiKey) { console.error('GOOGLE_AI_API_KEY required'); process.exit(1); }

  const modelRouter = new DefaultModelRouter({ anthropicApiKey, openrouterApiKey, googleAiApiKey });
  const strategy = new LatexStrategy();
  const chunker = new ChunkerStep();

  const rows = (await query<{ source_id: string; title: string; sources: { latex?: { path: string; rootTex?: string } } | null }>(
    `SELECT source_id, title, sources FROM documents WHERE source_id = ANY($1::text[]) AND source_format = 'latex'`,
    [ids],
  )).rows;

  for (const r of rows) {
    const latex = r.sources?.latex;
    if (!latex?.path) { console.error(`skip ${r.source_id}: no latex path`); continue; }

    // SYNTHETIC id → the UPDATE inside process() is a no-op (0 rows).
    const document = {
      id: randomUUID(),
      sourceId: r.source_id,
      title: r.title,
      sources: { latex: { path: latex.path, rootTex: latex.rootTex } },
      sourceFormat: 'latex' as const,
    } as unknown as Document;

    const costs: CostRow[] = [];
    const docLog = createChildLogger(`dryrun:${r.source_id}`);
    const context = {
      documentId: document.id,
      modelRouter,
      config: { stopSignal: { requested: false } },
      logger: {
        debug: (_m: string, _d?: unknown) => undefined,
        info: (_m: string, _d?: unknown) => undefined,
        warn: (m: string, _d?: unknown) => docLog.warn(m),
        error: (m: string, _d?: unknown) => docLog.error(m),
      },
      costTracker: {
        record: async (task: string, model: string, _p: string, inTok: number, outTok: number, cost: number, ms: number) => {
          costs.push({ task, model, cost, inTok, outTok, ms });
        },
      },
    } as unknown as PipelineContext;

    const parsed = await strategy.parse(document, context);
    const t0 = performance.now();
    let chunks: Chunk[] = [];
    try {
      chunks = await chunker.process({ parsed, document }, context);
    } catch (e) {
      console.error(`  ${r.source_id}: process() threw: ${(e as Error).message}`);
      continue;
    }
    const ms = Math.round(performance.now() - t0);

    const body = chunks.filter((c) => c.context.contentType !== 'abstract');
    const withCT = chunks.filter((c) => !!c.context.contentType).length;
    const withSum = chunks.filter((c) => !!c.context.summary).length;
    const total = chunks.length;
    const proCalls = costs.filter((c) => c.model.includes('pro')).length;
    const flashCalls = costs.filter((c) => c.model.includes('flash')).length;
    const totalCost = costs.reduce((s, c) => s + c.cost, 0);
    const totalOut = costs.reduce((s, c) => s + c.outTok, 0);

    console.error(`\n=== ${r.source_id} (${parsed.sections.length} sections) ===`);
    console.error(`  chunks: ${total} (body ${body.length})`);
    console.error(`  contentType set: ${withCT}/${total} (${(100 * withCT / total).toFixed(1)}%)  summary set: ${withSum}/${total} (${(100 * withSum / total).toFixed(1)}%)`);
    console.error(`  llm calls: ${flashCalls} flash + ${proCalls} pro;  out tok ${totalOut};  cost $${totalCost.toFixed(4)};  ${ms}ms`);
    console.error(`  null-contentType chunks (paragraph-fallback leak?): ${total - withCT}`);
  }

  await pool.end();
}

main().catch((err) => { console.error('[chunker-dryrun] fatal:', err); pool.end().finally(() => process.exit(1)); });
