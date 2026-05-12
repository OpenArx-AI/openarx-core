/**
 * Tiered benchmark extraction: regex → GROBID tables → LLM fallback.
 *
 * Tier 1 (free): regex patterns on chunk text
 * Tier 2 (free): structured table parsing from GROBID
 * Tier 3 (paid): LLM extraction — only when tiers 1+2 found 0 results
 *   AND paper has experiment/results/evaluation sections
 */

import type {
  BenchmarkResult,
  Chunk,
  ModelRouter,
  ParsedDocument,
  ParsedTable,
  PipelineContext,
} from '@openarx/types';
import { extractBenchmarkPatterns } from './regex-extractor.js';

// Metrics we recognize in table headers
const METRIC_KEYWORDS = [
  'accuracy',
  'acc',
  'top-1',
  'top-5',
  'f1',
  'bleu',
  'rouge',
  'rouge-l',
  'map',
  'mAP',
  'em',
  'exact match',
  'perplexity',
  'ppl',
  'auc',
  'precision',
  'recall',
  'wer',
  'cer',
  'meteor',
  'cider',
  'spice',
  'fid',
  'is',
  'ssim',
  'psnr',
];

const RESULTS_SECTION_RE = /\b(experiment|result|evaluation|benchmark|ablation)\b/i;

export class BenchmarkExtractor {
  async extract(
    parsed: ParsedDocument,
    chunks: Chunk[],
    context: PipelineContext,
  ): Promise<BenchmarkResult[]> {
    const { logger } = context;

    // Tier 1: Regex on chunk text
    const allText = chunks.map((c) => c.content).join('\n\n');
    const tier1 = extractBenchmarkPatterns(allText);

    if (tier1.length > 0) {
      logger.debug(`Tier 1 (regex): found ${tier1.length} benchmark results`);
      return this.deduplicate([...tier1, ...this.extractFromTables(parsed.tables)]);
    }

    // Tier 2: GROBID parsed tables
    const tier2 = this.extractFromTables(parsed.tables);

    if (tier2.length > 0) {
      logger.debug(`Tier 2 (tables): found ${tier2.length} benchmark results`);
      return this.deduplicate(tier2);
    }

    // Tier 3: LLM fallback — only if paper has results section
    const hasResultsSection = parsed.sections.some(
      (s) => RESULTS_SECTION_RE.test(s.name) || s.subsections?.some((ss) => RESULTS_SECTION_RE.test(ss.name)),
    );

    if (!hasResultsSection) {
      logger.debug('No results section found, skipping LLM benchmark extraction');
      return [];
    }

    const tier3 = await this.extractWithLlm(parsed, chunks, context);
    logger.debug(`Tier 3 (LLM): found ${tier3.length} benchmark results`);

    return this.deduplicate(tier3);
  }

  private extractFromTables(tables: ParsedTable[]): BenchmarkResult[] {
    const results: BenchmarkResult[] = [];

    for (const table of tables) {
      if (table.headers.length < 2 || table.rows.length === 0) continue;

      // Find metric columns by matching header names against known metrics
      const metricCols: Array<{ index: number; metric: string }> = [];
      const datasetCol = this.findDatasetColumn(table.headers);
      const taskCol = this.findColumn(table.headers, ['task']);

      for (let i = 0; i < table.headers.length; i++) {
        const header = table.headers[i].toLowerCase().trim();
        for (const metric of METRIC_KEYWORDS) {
          if (header.includes(metric.toLowerCase())) {
            metricCols.push({ index: i, metric: table.headers[i].trim() });
            break;
          }
        }
      }

      if (metricCols.length === 0) continue;

      for (const row of table.rows) {
        const dataset = datasetCol >= 0 ? row[datasetCol]?.trim() : (table.caption ?? '');
        const task = taskCol >= 0 ? row[taskCol]?.trim() : '';

        if (!dataset) continue;

        for (const { index, metric } of metricCols) {
          const scoreStr = row[index]?.trim();
          if (!scoreStr) continue;

          // Extract numeric value (handle "95.2%", "95.2 ± 0.1", bold "**95.2**")
          const cleaned = scoreStr.replace(/[*%±]/g, '').trim().split(/\s/)[0];
          const score = parseFloat(cleaned);
          if (isNaN(score)) continue;

          results.push({
            task: task || '',
            dataset,
            metric,
            score,
            extractedFrom: 'paper_text',
          });
        }
      }
    }

    return results;
  }

  private findDatasetColumn(headers: string[]): number {
    const keywords = ['dataset', 'benchmark', 'corpus', 'data'];
    return this.findColumn(headers, keywords);
  }

  private findColumn(headers: string[], keywords: string[]): number {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase().trim();
      if (keywords.some((k) => h.includes(k))) return i;
    }
    return -1;
  }

  private async extractWithLlm(
    parsed: ParsedDocument,
    chunks: Chunk[],
    context: PipelineContext,
  ): Promise<BenchmarkResult[]> {
    const { modelRouter, logger, costTracker } = context;

    // Find results/experiment section content
    const resultChunks = chunks.filter((c) =>
      RESULTS_SECTION_RE.test(c.context.sectionName ?? ''),
    );

    const text = resultChunks.length > 0
      ? resultChunks.map((c) => c.content).join('\n\n')
      : chunks.slice(-5).map((c) => c.content).join('\n\n'); // fallback: last 5 chunks

    // Truncate to ~4000 chars to manage cost
    const truncated = text.slice(0, 4000);

    const prompt = `Extract benchmark results from this paper section. Return a JSON array of objects with these fields:
- task: the ML task (e.g. "Image Classification", "Machine Translation")
- dataset: the evaluation dataset name
- metric: the evaluation metric name
- score: the numeric score (number, not string)

Only include results explicitly stated with numeric scores. If no benchmarks found, return [].

Text:
${truncated}

Return ONLY the JSON array, no other text.`;

    try {
      const start = performance.now();
      const response = await modelRouter.complete('enrichment', prompt);
      const durationMs = Math.round(performance.now() - start);

      await costTracker.record(
        'enrichment-benchmark',
        response.model,
        response.provider ?? 'openrouter',
        response.inputTokens,
        response.outputTokens,
        response.cost,
        durationMs,
      );

      return this.parseLlmResponse(response.text);
    } catch (err) {
      logger.warn('LLM benchmark extraction failed', err);
      return [];
    }
  }

  private parseLlmResponse(text: string): BenchmarkResult[] {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned) as Array<{
        task?: string;
        dataset?: string;
        metric?: string;
        score?: number;
      }>;

      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((r) => r.dataset && r.metric && typeof r.score === 'number')
        .map((r) => ({
          task: r.task ?? '',
          dataset: r.dataset!,
          metric: r.metric!,
          score: r.score!,
          extractedFrom: 'paper_text' as const,
        }));
    } catch {
      return [];
    }
  }

  private deduplicate(results: BenchmarkResult[]): BenchmarkResult[] {
    const seen = new Set<string>();
    return results.filter((r) => {
      const key = `${r.dataset}|${r.metric}|${r.score}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
