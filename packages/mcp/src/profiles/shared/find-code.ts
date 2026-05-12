import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Document, CodeLink, DatasetLink, BenchmarkResult } from '@openarx/types';
import type { AppContext } from '../../context.js';
import { deduplicateByDocument, fetchDocuments, jsonResult, computeCanServeFile } from './helpers.js';
import { recordEmbed } from '../../lib/usage-tracker.js';

export function registerFindCode(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_code',
    'Find papers with associated code repositories, datasets, or benchmark results. Filter by ML task, dataset, framework, or GitHub stars. Returns top items per paper (not full lists by default — use detail=full for everything).',
    {
      query: z.string().optional().describe(
        'Optional semantic query — papers about this topic with code',
      ),
      task: z.string().optional().describe(
        'Task name to match against benchmark_results (e.g. "question answering")',
      ),
      dataset: z.string().optional().describe(
        'Dataset name (e.g. "SQuAD", "ImageNet") — matches dataset_links.name + benchmark_results.dataset',
      ),
      framework: z.string().optional().describe(
        '"PyTorch" / "TensorFlow" / "JAX" / etc. — matches code_links.language',
      ),
      minStars: z.number().int().optional().describe(
        'Minimum GitHub stars on at least one code_link',
      ),
      categories: z.array(z.string()).optional()
        .describe('Filter by arXiv categories (e.g. cs.AI, cs.LG)'),
      dateFrom: z.string().optional().describe('Filter: published on or after (ISO date)'),
      dateTo: z.string().optional().describe('Filter: published on or before (ISO date)'),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard').describe(
        "'minimal' = counts + first item each. 'standard' = top-3 per type. 'full' = all arrays.",
      ),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ query, task, dataset, framework, minStars, categories, dateFrom, dateTo, detail, limit }) => {
      let candidates: Array<{ documentId: string; score?: number }>;

      if (query) {
        // Semantic-anchored search: vector retrieve, dedupe by doc
        const resp = await ctx.geminiEmbedder.embed([query]);
        recordEmbed(resp);
        const vector = resp.vectors[0];
        const raw = await ctx.vectorStore.search(vector, 'gemini', limit * 8);
        const deduped = deduplicateByDocument(raw);
        candidates = deduped.map((r) => ({ documentId: r.documentId, score: r.score }));
      } else {
        // No query — pure structured filter on documents table
        const conds: string[] = [
          `status = 'ready'`,
          `(jsonb_array_length(coalesce(code_links, '[]'::jsonb)) > 0
            OR jsonb_array_length(coalesce(dataset_links, '[]'::jsonb)) > 0
            OR jsonb_array_length(coalesce(benchmark_results, '[]'::jsonb)) > 0)`,
          `deleted_at IS NULL`,
        ];
        const params: unknown[] = [];
        if (task) {
          params.push(`%${task.toLowerCase()}%`);
          conds.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(benchmark_results, '[]'::jsonb)) br WHERE LOWER(br->>'task') LIKE $${params.length})`);
        }
        if (dataset) {
          params.push(`%${dataset.toLowerCase()}%`);
          conds.push(`(
            EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(dataset_links, '[]'::jsonb)) dl WHERE LOWER(dl->>'name') LIKE $${params.length})
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(benchmark_results, '[]'::jsonb)) br WHERE LOWER(br->>'dataset') LIKE $${params.length})
          )`);
        }
        // BUG-C-01: pre-filter by minStars / framework so candidate fetch
        // doesn't burn its limit on papers without matching code_links.
        if (typeof minStars === 'number') {
          params.push(minStars);
          conds.push(`EXISTS (
            SELECT 1 FROM jsonb_array_elements(coalesce(code_links, '[]'::jsonb)) cl
            WHERE (cl->>'stars')::int >= $${params.length}
          )`);
        }
        if (framework) {
          params.push(`%${framework.toLowerCase()}%`);
          conds.push(`EXISTS (
            SELECT 1 FROM jsonb_array_elements(coalesce(code_links, '[]'::jsonb)) cl
            WHERE LOWER(coalesce(cl->>'language', cl->>'framework', '')) LIKE $${params.length}
          )`);
        }
        if (categories && categories.length > 0) {
          params.push(categories);
          conds.push(`categories && $${params.length}::text[]`);
        }
        if (dateFrom) {
          params.push(dateFrom);
          conds.push(`published_at >= $${params.length}::timestamptz`);
        }
        if (dateTo) {
          params.push(dateTo);
          conds.push(`published_at <= $${params.length}::timestamptz`);
        }
        params.push(limit * 4);
        const sql = `SELECT id FROM documents WHERE ${conds.join(' AND ')} ORDER BY published_at DESC LIMIT $${params.length}`;
        const { rows } = await ctx.pool.query<{ id: string }>(sql, params);
        candidates = rows.map((r) => ({ documentId: r.id }));
      }

      const docs = await fetchDocuments(candidates.map((c) => c.documentId), ctx);

      // Apply post-fetch structured filters and rank items per document
      const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
      const dateToMs = dateTo ? new Date(dateTo).getTime() : undefined;
      const catSet = categories && categories.length > 0 ? new Set(categories) : null;

      const results: Array<Record<string, unknown>> = [];
      for (const cand of candidates) {
        const doc = docs.get(cand.documentId);
        if (!doc) continue;

        // Doc-level filters (category / date range) apply on both query and
        // no-query paths; SQL pre-filter already enforces them on no-query
        // path, this is the equivalent for the vector path.
        if (catSet && !doc.categories.some((c) => catSet.has(c))) continue;
        const ms = doc.publishedAt.getTime();
        if (dateFromMs && ms < dateFromMs) continue;
        if (dateToMs && ms > dateToMs) continue;

        // Coarse "any links" filter
        const hasCode = doc.codeLinks.length > 0;
        const hasDatasets = doc.datasetLinks.length > 0;
        const hasBenchmarks = doc.benchmarkResults.length > 0;
        if (!hasCode && !hasDatasets && !hasBenchmarks) continue;

        // Filter codeLinks by framework / minStars. framework matches against
        // either `language` (canonical TS type) or a free-form `framework`
        // JSONB key (some PwC-imported entries carry it explicitly).
        let codeMatched: CodeLink[] = doc.codeLinks;
        if (framework) {
          const fwLower = framework.toLowerCase();
          codeMatched = codeMatched.filter((c) => {
            const lang = c.language?.toLowerCase() ?? '';
            const fw = ((c as unknown as { framework?: string }).framework ?? '').toLowerCase();
            return lang.includes(fwLower) || fw.includes(fwLower);
          });
        }
        if (typeof minStars === 'number') {
          codeMatched = codeMatched.filter((c) => (c.stars ?? 0) >= minStars);
        }

        // Filter datasetLinks by dataset
        let datasetMatched: DatasetLink[] = doc.datasetLinks;
        if (dataset) {
          const dsLower = dataset.toLowerCase();
          datasetMatched = datasetMatched.filter((d) => d.name.toLowerCase().includes(dsLower));
        }

        // Filter benchmark_results by task / dataset
        let benchmarksMatched: BenchmarkResult[] = doc.benchmarkResults;
        if (task) {
          const taskLower = task.toLowerCase();
          benchmarksMatched = benchmarksMatched.filter((b) => b.task.toLowerCase().includes(taskLower));
        }
        if (dataset) {
          const dsLower = dataset.toLowerCase();
          benchmarksMatched = benchmarksMatched.filter((b) => b.dataset.toLowerCase().includes(dsLower));
        }

        // BUG-C-01: each filter independently gates document inclusion.
        // Old logic dropped docs only when ALL three matched arrays were
        // empty — letting `find_code({minStars:10000})` return papers with
        // empty codeLinks because they happened to have unrelated dataset
        // or benchmark links. Now: a filter on a specific link type
        // requires that link type to have a non-empty match.
        if ((framework !== undefined || minStars !== undefined) && codeMatched.length === 0) continue;
        if (task !== undefined && benchmarksMatched.length === 0) continue;
        if (dataset !== undefined && datasetMatched.length === 0 && benchmarksMatched.length === 0) continue;

        // Rank codeMatched by stars (desc), keep top-3 in standard, all in full
        const codeRanked = [...codeMatched].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
        const benchmarksRanked = [...benchmarksMatched].sort((a, b) => b.score - a.score);

        results.push(formatResult(doc, codeRanked, datasetMatched, benchmarksRanked, detail as 'minimal' | 'standard' | 'full'));
        if (results.length >= limit) break;
      }

      return jsonResult({ results });
    },
  );
}

function formatResult(
  doc: Document,
  code: CodeLink[],
  datasets: DatasetLink[],
  benchmarks: BenchmarkResult[],
  detail: 'minimal' | 'standard' | 'full',
): Record<string, unknown> {
  if (detail === 'minimal') {
    return {
      documentId: doc.id,
      documentTitle: doc.title,
      counts: {
        code: code.length,
        datasets: datasets.length,
        benchmarks: benchmarks.length,
      },
      topCode: code[0] ?? null,
      topDataset: datasets[0] ?? null,
      topBenchmark: benchmarks[0] ?? null,
    };
  }

  const limit = detail === 'full' ? Number.POSITIVE_INFINITY : 3;
  const result: Record<string, unknown> = {
    documentId: doc.id,
    documentTitle: doc.title,
    publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : doc.publishedAt,
    license: doc.license ?? null,
    indexingTier: doc.indexingTier ?? 'full',
    canServeFile: computeCanServeFile(doc),
    codeLinks: code.slice(0, limit),
    codeLinksCount: code.length,
    datasetLinks: datasets.slice(0, limit),
    datasetLinksCount: datasets.length,
    benchmarkResults: benchmarks.slice(0, limit),
    benchmarkResultsCount: benchmarks.length,
  };

  if (detail === 'full') {
    result.authors = doc.authors;
    result.categories = doc.categories;
    result.externalIds = doc.externalIds;
  }
  return result;
}
