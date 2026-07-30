/**
 * EXPERIMENT HARNESS (openarx-9kv0) — re-index COST probe. NOT shipped.
 *
 * Measures the LLM cost of re-running BENCHMARK extraction (the targeted
 * re-index for the garble fix) on N AFFECTED documents — those that currently
 * carry >=1 stub-dataset benchmark row. READ-ONLY: never writes `documents` or
 * the costs table (uses an in-memory cost tracker). Uses the production model
 * router (Vertex when GOOGLE_SA_KEY_FILE is set) so cost is representative.
 * Run on S1 with the prod .env sourced.
 *
 *   pnpm --filter @openarx/ingest exec tsx src/scripts/exp-benchmark-cost.ts --n 100
 */
import { DefaultModelRouter, pool, query } from '@openarx/api';
import type {
  Chunk,
  ChunkContext,
  ParsedDocument,
  ParsedSection,
  ParsedTable,
  PipelineContext,
} from '@openarx/types';
import { BenchmarkExtractor } from '../pipeline/enricher/benchmark-extractor.js';

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1] ?? 100) || 100;
const AFFECTED_TOTAL = 18400; // docs with >=1 stub-dataset row (for extrapolation)

interface DocRow {
  id: string;
  source_id: string;
  structured_content: { tables?: ParsedTable[]; sections?: ParsedSection[] } | null;
  bench_before: number;
}
interface ChunkRow {
  content: string;
  context: ChunkContext | null;
  section_title: string | null;
  position: number | null;
}

async function loadChunks(id: string): Promise<Chunk[]> {
  const { rows } = await query<ChunkRow>(
    `SELECT content, context, section_title, position FROM chunks
     WHERE document_id=$1 ORDER BY position ASC NULLS LAST, created_at ASC`,
    [id],
  );
  return rows.map((r, i) => ({
    id: String(i), version: 1, createdAt: new Date(), documentId: id,
    content: r.content,
    context: {
      ...(r.context ?? {}),
      sectionName: r.section_title ?? r.context?.sectionName,
      positionInDocument: r.position ?? r.context?.positionInDocument ?? i,
    } as ChunkContext,
    vectors: {}, metrics: {} as Record<string, never>,
  }));
}

async function main(): Promise<void> {
  const modelRouter = new DefaultModelRouter({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    googleAiApiKey: process.env.GOOGLE_AI_API_KEY,
  });
  const extractor = new BenchmarkExtractor();

  const { rows: ids } = await query<{ id: string }>(
    `SELECT DISTINCT d.id FROM documents d, jsonb_array_elements(d.benchmark_results) e
     WHERE jsonb_typeof(d.benchmark_results)='array'
       AND (e->>'dataset' ~* '^\\s*table\\s*[0-9]'
            OR lower(e->>'dataset') IN ('not specified','n/a','unknown','none'))
     ORDER BY d.id LIMIT $1`,
    [N],
  );
  console.log(`Sampled ${ids.length} affected docs. Measuring benchmark re-index LLM cost...`);

  const per: Array<{ id: string; src: string; cost: number; llmFired: boolean; before: number; after: number; ms: number }> = [];
  let totalCost = 0;
  let llmFiredDocs = 0;
  let errors = 0;

  for (let i = 0; i < ids.length; i++) {
    const { rows } = await query<DocRow>(
      `SELECT id, source_id, structured_content,
              jsonb_array_length(coalesce(benchmark_results,'[]'::jsonb)) AS bench_before
       FROM documents WHERE id=$1`, [ids[i].id]);
    const doc = rows[0];
    if (!doc) continue;

    const parsed: ParsedDocument = {
      title: '', abstract: '',
      sections: doc.structured_content?.sections ?? [],
      references: [], tables: doc.structured_content?.tables ?? [],
      formulas: [], parserUsed: 'stored', parseDurationMs: 0,
    };
    const chunks = await loadChunks(doc.id);

    const docCost = { total: 0, calls: 0 };
    const ctx = {
      documentId: doc.id, modelRouter, config: {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      costTracker: {
        async record(_t: string, _m: string, _p: string, _i: number, _o: number, cost: number) {
          docCost.total += cost ?? 0; docCost.calls++;
        },
      },
    } as unknown as PipelineContext;

    const t0 = Date.now();
    let after = 0;
    try {
      const res = await extractor.extract(parsed, chunks, ctx);
      after = res.length;
    } catch (e) {
      errors++;
      console.error(`  ${doc.source_id}: ERR ${e instanceof Error ? e.message : e}`);
    }
    const ms = Date.now() - t0;
    totalCost += docCost.total;
    const llmFired = docCost.calls > 0;
    if (llmFired) llmFiredDocs++;
    per.push({ id: doc.id, src: doc.source_id, cost: docCost.total, llmFired, before: doc.bench_before, after, ms });
    if ((i + 1) % 10 === 0)
      console.log(`  ${i + 1}/${ids.length}  cost=$${totalCost.toFixed(4)}  llm-fired=${llmFiredDocs}`);
  }

  const n = per.length || 1;
  const costPerDoc = totalCost / n;
  const fireRate = llmFiredDocs / n;
  const costs = per.map((p) => p.cost).sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)] ?? 0;
  const max = costs[costs.length - 1] ?? 0;
  const costPerFired = llmFiredDocs ? totalCost / llmFiredDocs : 0;

  console.log('\n========== BENCHMARK RE-INDEX COST ==========');
  console.log(`docs measured:            ${per.length}  (errors: ${errors})`);
  console.log(`Tier-3 LLM fired:         ${llmFiredDocs} docs (${(fireRate * 100).toFixed(0)}%)`);
  console.log(`TOTAL cost:               $${totalCost.toFixed(4)}`);
  console.log(`cost / doc (all):         $${costPerDoc.toFixed(5)}`);
  console.log(`cost / doc (LLM-fired):   $${costPerFired.toFixed(5)}`);
  console.log(`per-doc cost  median/max: $${median.toFixed(5)} / $${max.toFixed(5)}`);
  console.log(`avg latency/doc:          ${Math.round(per.reduce((s, p) => s + p.ms, 0) / n)} ms`);
  console.log('---------------------------------------------');
  console.log(`EXTRAPOLATION to ~${AFFECTED_TOTAL} affected docs:`);
  console.log(`  ≈ $${(costPerDoc * AFFECTED_TOTAL).toFixed(2)}  (at $${costPerDoc.toFixed(5)}/doc)`);
  console.log('=============================================');

  await pool.end();
}

main().catch((e) => { console.error('cost probe failed:', e); process.exit(1); });
