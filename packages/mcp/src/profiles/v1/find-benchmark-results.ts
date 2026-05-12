import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { jsonResult } from '../shared/helpers.js';

interface BenchmarkRow {
  document_id: string;
  title: string;
  published_at: Date;
  task: string;
  dataset: string;
  metric: string;
  score: number;
  method: string | null;
}

// LLM extraction (chunker-step.ts) populates documents.benchmark_results from
// any "X = Y on Z" pattern in the text — including parameter counts, FLOPs,
// dataset cardinalities. This filter restricts read-side to metrics that
// represent actual task performance. See QA BUG-B-01 (2026-05-08).
//
// Allow: canonical performance metric names (substring, case-insensitive).
// Reject: anything mentioning model-size / compute / cardinality / timing.
// Both are applied — a metric must match allow AND not match reject.
const PERF_METRIC_ALLOW_RE =
  '(accuracy|\\bacc\\b|f1|f-score|fscore|precision|recall|bleu|rouge|meteor|' +
  'exact match|\\bem\\b|top-?[15]|\\bmap\\b|auroc|\\bauc\\b|iou|intersection over union|' +
  'ndcg|mrr|hit@|pearson|spearman|\\bwer\\b|\\bcer\\b|bertscore|bert-score|' +
  '\\bscore\\b|mean reciprocal rank|f-measure|recall@|precision@|pass@|' +
  'psnr|ssim|\\bfid\\b|\\bkid\\b|perplexity|\\bppl\\b|win rate|elo|' +
  'spbleu|chrf|ter|sacrebleu)';

const PERF_METRIC_REJECT_RE =
  '(parameter|\\bparam\\b|flop|\\bmac\\b|count|size|length|' +
  'time|latency|\\bms\\b|second|memor|\\btokens?\\b|vocab|' +
  'iteration|epoch|step|throughput|\\bfps\\b|byte|\\bgb\\b|\\bmb\\b)';

export function registerFindBenchmarkResults(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_benchmark_results',
    'Query structured benchmark scores from research papers. Returns leaderboard-style results: task, dataset, metric, score, method, paper, year. Backed by LLM-extracted benchmark records, filtered to performance metrics only (accuracy / F1 / BLEU / ROUGE / mAP / top-1 / top-5 / pass@k / etc.) — model-size, FLOPs, dataset cardinality and similar are excluded. Best for ML benchmark / leaderboard papers; may return empty for theoretical / survey papers without numerical results. Filter by task, dataset, metric. Use for SOTA tracking, SOTA-trajectory analysis, comparing methods on common benchmarks. At least one of task / dataset / metric is required.',
    {
      task: z.string().optional().describe(
        'Task name like "question answering", "image classification" (case-insensitive partial match). REQUIRED if dataset and metric are not provided.',
      ),
      dataset: z.string().optional().describe(
        'Dataset name like "SQuAD", "ImageNet", "GLUE". REQUIRED if task and metric are not provided.',
      ),
      metric: z.string().optional().describe(
        'Metric name like "F1", "accuracy", "BLEU". REQUIRED if task and dataset are not provided.',
      ),
      minScore: z.number().optional().describe(
        'Minimum benchmark score (filter for SOTA leaderboard view)',
      ),
      minYear: z.number().int().optional().describe(
        'Year >= (e.g. 2023 to filter out older results)',
      ),
      categories: z.array(z.string()).optional().describe(
        'arXiv category filter',
      ),
      topK: z.number().int().min(1).max(50).default(10).describe(
        'Top-K results by score',
      ),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard'),
    },
    async ({ task, dataset, metric, minScore, minYear, categories, topK, detail }) => {
      if (!task && !dataset && !metric) {
        return jsonResult({
          error: 'At least one of task / dataset / metric is required to scope the query',
        });
      }

      const conds: string[] = [
        `d.status = 'ready'`,
        `d.deleted_at IS NULL`,
        `jsonb_array_length(coalesce(d.benchmark_results, '[]'::jsonb)) > 0`,
      ];
      const params: unknown[] = [];

      // Build benchmark filter as jsonb path expression — apply via lateral join below.
      // Always-on whitelist + blacklist (BUG-B-01 fix): drop non-performance metrics
      // before they reach the user. Implemented as parameterized regex so it stays
      // editable without DB migration.
      const brConds: string[] = [];
      params.push(PERF_METRIC_ALLOW_RE);
      brConds.push(`br->>'metric' ~* $${params.length}`);
      params.push(PERF_METRIC_REJECT_RE);
      brConds.push(`br->>'metric' !~* $${params.length}`);
      if (task) {
        params.push(`%${task.toLowerCase()}%`);
        brConds.push(`LOWER(br->>'task') LIKE $${params.length}`);
      }
      if (dataset) {
        params.push(`%${dataset.toLowerCase()}%`);
        brConds.push(`LOWER(br->>'dataset') LIKE $${params.length}`);
      }
      if (metric) {
        params.push(`%${metric.toLowerCase()}%`);
        brConds.push(`LOWER(br->>'metric') LIKE $${params.length}`);
      }
      if (typeof minScore === 'number') {
        params.push(minScore);
        brConds.push(`(br->>'score')::numeric >= $${params.length}`);
      }
      if (typeof minYear === 'number') {
        params.push(`${minYear}-01-01`);
        conds.push(`d.published_at >= $${params.length}::timestamptz`);
      }
      if (categories && categories.length > 0) {
        params.push(categories);
        conds.push(`d.categories && $${params.length}::text[]`);
      }

      params.push(topK);

      const sql = `
        SELECT d.id AS document_id, d.title, d.published_at,
               br->>'task' AS task,
               br->>'dataset' AS dataset,
               br->>'metric' AS metric,
               (br->>'score')::numeric AS score,
               br->>'method' AS method
        FROM documents d
        CROSS JOIN LATERAL jsonb_array_elements(d.benchmark_results) br
        WHERE ${conds.join(' AND ')}
          ${brConds.length ? 'AND ' + brConds.join(' AND ') : ''}
        ORDER BY score DESC NULLS LAST, d.published_at DESC
        LIMIT $${params.length}
      `;

      const { rows } = await ctx.pool.query<BenchmarkRow>(sql, params);

      const results = rows.map((r) => formatBenchmark(r, detail as 'minimal' | 'standard' | 'full'));

      // Trajectory aggregation: only when task+metric+dataset are all provided
      // → "best score per year" timeline. Built post-hoc from the main rows
      // (already sorted by score DESC) — first occurrence of each year is the
      // top scorer that year. No second SQL query, no injection risk.
      let trajectory: Array<{ year: number; bestScore: number; method: string | null; documentId: string }> | undefined;
      if (task && metric && dataset && rows.length > 0) {
        const byYear = new Map<number, { bestScore: number; method: string | null; documentId: string }>();
        for (const r of rows) {
          const year = new Date(r.published_at).getUTCFullYear();
          const score = typeof r.score === 'string' ? parseFloat(r.score) : r.score;
          const existing = byYear.get(year);
          if (!existing || score > existing.bestScore) {
            byYear.set(year, { bestScore: score, method: r.method, documentId: r.document_id });
          }
        }
        trajectory = [...byYear.entries()]
          .map(([year, v]) => ({ year, ...v }))
          .sort((a, b) => a.year - b.year);
      }

      return jsonResult({
        filters: { task, dataset, metric, minScore, minYear },
        results,
        ...(trajectory ? { trajectory } : {}),
      });
    },
  );
}

function formatBenchmark(
  r: BenchmarkRow,
  detail: 'minimal' | 'standard' | 'full',
): Record<string, unknown> {
  if (detail === 'minimal') {
    return {
      documentId: r.document_id,
      score: r.score,
      method: r.method,
      year: new Date(r.published_at).getUTCFullYear(),
    };
  }

  return {
    documentId: r.document_id,
    documentTitle: r.title,
    method: r.method,
    task: r.task,
    dataset: r.dataset,
    metric: r.metric,
    score: r.score,
    publishedAt: r.published_at instanceof Date ? r.published_at.toISOString() : r.published_at,
    year: new Date(r.published_at).getUTCFullYear(),
  };
}
