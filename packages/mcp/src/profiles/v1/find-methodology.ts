import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, jsonResult, truncateChunk } from '../shared/helpers.js';
import {
  hydrateChunkContexts,
  applyChunkContextFilters,
  type RankedChunk,
} from '../shared/search-helpers.js';
import { recordLlm } from '../../lib/usage-tracker.js';

interface MethodExtraction {
  method_name: string | null;
  key_idea: string | null;
}

export function registerFindMethodology(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_methodology',
    'Find methodology approaches for a specific research task. Returns structured method-level results (not raw chunks): method name, key idea, dataset used, performance metric. Filters by task domain, dataset, metric. Built on LLM-classified contentType=methodology chunks combined with benchmark results JOIN. Use this instead of `search` when you want HOW researchers approach a problem rather than 10 papers about it. Note: surfaces any chunk classified as methodology, including ones where the task is mentioned only as a toy example. Filter by category (e.g. cs.CV for image tasks) to narrow scope.',
    {
      task: z.string().describe(
        'Research task: "relation extraction", "question answering", "image classification"',
      ),
      dataset: z.string().optional().describe(
        'Specific dataset name: "SQuAD", "ImageNet", "GLUE"',
      ),
      metric: z.string().optional().describe(
        'Evaluation metric: "F1", "accuracy", "BLEU"',
      ),
      framework: z.string().optional().describe(
        'ML framework filter: "PyTorch", "TensorFlow"',
      ),
      categories: z.array(z.string()).optional()
        .describe('Filter by arXiv categories (e.g. cs.AI, cs.LG)'),
      dateFrom: z.string().optional().describe('Filter: published on or after (ISO date)'),
      dateTo: z.string().optional().describe('Filter: published on or before (ISO date)'),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard').describe(
        "'standard'/'full' invoke an extra LLM extraction step to surface method_name + key_idea (~1.5s overhead). 'minimal' skips it.",
      ),
      limit: z.number().int().min(1).max(30).default(10).describe('Max results to return'),
    },
    async ({ task, dataset, metric, framework, categories, dateFrom, dateTo, detail, limit }) => {
      // Build hybrid query: task + entities[dataset, metric]
      const queryText = [task, dataset, metric].filter(Boolean).join(' ');
      const entitiesFilter = [dataset, metric, framework].filter((x): x is string => !!x);

      const { vector, vectorName } = await embedQuery(queryText, 'gemini', ctx);

      const POOL = Math.max(50, limit * 6);
      const vectorRaw = await ctx.vectorStore.search(vector, vectorName, POOL);

      let chunks: RankedChunk[] = vectorRaw.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        content: r.content,
        context: r.context,
        vectorScore: r.score,
        bm25Score: 0,
        finalScore: r.score,
      }));

      chunks = await hydrateChunkContexts(chunks, ctx);

      // Filter to methodology chunks
      chunks = applyChunkContextFilters(chunks, {
        contentType: ['methodology'],
        ...(entitiesFilter.length > 0 ? { entities: entitiesFilter } : {}),
      });

      // Doc-level filters
      const candidateDocIds = [...new Set(chunks.map((c) => c.documentId))];
      const docs = await fetchDocuments(candidateDocIds, ctx);
      const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
      const dateToMs = dateTo ? new Date(dateTo).getTime() : undefined;
      const catSet = categories && categories.length > 0 ? new Set(categories) : null;

      chunks = chunks.filter((c) => {
        const doc = docs.get(c.documentId);
        if (!doc) return false;
        if (catSet && !doc.categories.some((cat) => catSet.has(cat))) return false;
        const ms = doc.publishedAt.getTime();
        if (dateFromMs && ms < dateFromMs) return false;
        if (dateToMs && ms > dateToMs) return false;
        return true;
      });

      // One methodology chunk per document (top-scoring)
      const seen = new Set<string>();
      const perDoc: RankedChunk[] = [];
      for (const c of chunks) {
        if (seen.has(c.documentId)) continue;
        seen.add(c.documentId);
        perDoc.push(c);
        if (perDoc.length >= limit) break;
      }

      // Optional LLM extraction of method_name + key_idea (standard/full)
      const extractions = new Map<string, MethodExtraction>();
      if (detail !== 'minimal') {
        await Promise.all(perDoc.map(async (c) => {
          try {
            const ext = await extractMethod(ctx, task, c.content);
            extractions.set(c.chunkId, ext);
          } catch (err) {
            // Best-effort — leave fields null on failure
            console.error('[find_methodology] extraction failed:', err instanceof Error ? err.message : err);
          }
        }));
      }

      // Match benchmark_results when (task) and optionally (dataset, metric) match
      const results = perDoc.map((c) => {
        const doc = docs.get(c.documentId)!;
        const bench = matchBenchmark(doc.benchmarkResults, task, dataset, metric);
        const ext = extractions.get(c.chunkId);

        if (detail === 'minimal') {
          return {
            documentId: c.documentId,
            documentTitle: doc.title,
            chunkContent: truncateChunk(c.content).slice(0, 400),
            score: c.finalScore,
            ...(bench ? { benchmark: bench } : {}),
          };
        }

        return {
          documentId: c.documentId,
          documentTitle: doc.title,
          publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : doc.publishedAt,
          method_name: ext?.method_name ?? null,
          key_idea: ext?.key_idea ?? c.context.summary ?? null,
          chunkContent: truncateChunk(c.content),
          chunkContextSummary: c.context.summary ?? null,
          chunkKeyConcept: c.context.keyConcept ?? null,
          score: c.finalScore,
          ...(bench ? { benchmark: bench } : {}),
          ...(detail === 'full' ? {
            entities: c.context.entities ?? [],
            authors: doc.authors.map((a) => a.name),
            categories: doc.categories,
            license: doc.license ?? null,
            codeLinkCount: doc.codeLinks.length,
          } : {}),
        };
      });

      return jsonResult({
        task,
        dataset: dataset ?? null,
        metric: metric ?? null,
        results,
      });
    },
  );
}

async function extractMethod(
  ctx: AppContext,
  task: string,
  content: string,
): Promise<MethodExtraction> {
  const prompt = `You are extracting structured method information from a research paper chunk about "${task}".

Read the chunk and return a JSON object with:
  "method_name": short name of the method described (3-8 words). Null if not present.
  "key_idea": 1 sentence (max 25 words) describing the central methodological idea. Null if no method described.

Output JSON only, no surrounding text.

Chunk:
"""
${content.slice(0, 3000)}
"""`;

  const resp = await ctx.modelRouter.complete('enrichment', prompt, {
    maxTokens: 200,
    temperature: 0.1,
  });
  recordLlm(resp, 'enrichment');

  // Extract JSON object from response (model may include prose around it)
  const match = resp.text.match(/\{[\s\S]*\}/);
  if (!match) return { method_name: null, key_idea: null };
  try {
    const obj = JSON.parse(match[0]);
    return {
      method_name: typeof obj.method_name === 'string' && obj.method_name.length > 0 ? obj.method_name : null,
      key_idea: typeof obj.key_idea === 'string' && obj.key_idea.length > 0 ? obj.key_idea : null,
    };
  } catch {
    return { method_name: null, key_idea: null };
  }
}

function matchBenchmark(
  benchmarks: import('@openarx/types').BenchmarkResult[],
  task: string,
  dataset?: string,
  metric?: string,
): { task: string; dataset: string; metric: string; score: number } | null {
  const taskL = task.toLowerCase();
  const dsL = dataset?.toLowerCase();
  const mL = metric?.toLowerCase();
  const scored = benchmarks.filter((b) => {
    if (!b.task.toLowerCase().includes(taskL)) return false;
    if (dsL && !b.dataset.toLowerCase().includes(dsL)) return false;
    if (mL && !b.metric.toLowerCase().includes(mL)) return false;
    return true;
  });
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return { task: top.task, dataset: top.dataset, metric: top.metric, score: top.score };
}
