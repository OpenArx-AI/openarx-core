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

// Stub / placeholder dataset labels that must NOT be emitted as a real dataset
// name. Two literals seen in the wild (openarx-9kv0): GROBID table-caption
// fallback ("Table 2 :") and the LLM's "Not specified" placeholder.
const DATASET_STUB_RE = /^(?:table\s*\d*\s*[:.]?|not\s*specified|n\.?\/?a\.?|unknown|none|[-–—]+)$/i;

export function isStubDataset(s: string | null | undefined): boolean {
  const t = s?.trim();
  if (!t) return true;
  return DATASET_STUB_RE.test(t);
}

// Word-boundary (non-alphanumeric delimited) matcher for metric-column headers.
// Replaces the old `header.includes(metric)` substring test, which false-matched
// short tokens like 'em' (exact-match) INSIDE ordinary words — "M-em-ory",
// "T-em-poral", "PerM-em", "Emb-odied" — turning task/benchmark-name columns into
// bogus metric columns with a glued header as the "metric" (openarx-9kv0).
const METRIC_RE = new RegExp(
  '(?<![a-z0-9])(?:' +
    METRIC_KEYWORDS.slice()
      .sort((a, b) => b.length - a.length) // longest alternative first
      .map((k) =>
        k
          .toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex metachars
          .replace(/\s+/g, '\\s+'),
      )
      .join('|') +
    ')(?![a-z0-9])',
  'i',
);

/** True when a header names a recognized metric as a whole token (not a substring). */
export function headerHasMetric(header: string): boolean {
  return METRIC_RE.test(header);
}

/** Parse a single benchmark score cell ("95.2%", "**95.2**", "2,202", "0.41 ± 0.1"). */
export function parseScoreCell(cell: string | undefined): number {
  if (!cell) return NaN;
  const cleaned = cell.replace(/[*%±,]/g, '').trim().split(/\s+/)[0];
  return parseFloat(cleaned);
}

/** A metric column must hold numbers in the majority of its data rows. Guards the
 *  malformed-table case where a glued/misaligned header sits over a text column. */
export function columnIsNumeric(rows: string[][], index: number): boolean {
  let numeric = 0;
  let total = 0;
  for (const row of rows) {
    const cell = row[index];
    if (cell === undefined || cell.trim() === '') continue;
    total++;
    if (!Number.isNaN(parseScoreCell(cell))) numeric++;
  }
  return total > 0 && numeric / total >= 0.5;
}

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

      // Find metric columns: header names a recognized metric AS A TOKEN (not a
      // substring) AND the column actually holds numbers in most rows.
      const metricCols: Array<{ index: number; metric: string }> = [];
      const datasetCol = this.findDatasetColumn(table.headers);
      const taskCol = this.findColumn(table.headers, ['task']);

      for (let i = 0; i < table.headers.length; i++) {
        if (i === datasetCol || i === taskCol) continue;
        const header = table.headers[i].trim();
        if (headerHasMetric(header) && columnIsNumeric(table.rows, i)) {
          metricCols.push({ index: i, metric: header });
        }
      }

      if (metricCols.length === 0) continue;

      // Dataset: prefer an explicit dataset column; else fall back to the caption
      // with any "Table N :" prefix stripped. Reject stub labels outright.
      const captionDataset = (table.caption ?? '')
        .replace(/^\s*table\s*\d*\s*[:.]?\s*/i, '')
        .trim();

      for (const row of table.rows) {
        const colDataset = datasetCol >= 0 ? row[datasetCol]?.trim() : '';
        const dataset = colDataset && !isStubDataset(colDataset) ? colDataset : captionDataset;
        const task = taskCol >= 0 ? row[taskCol]?.trim() : '';

        if (isStubDataset(dataset)) continue;

        for (const { index, metric } of metricCols) {
          const score = parseScoreCell(row[index]);
          if (Number.isNaN(score)) continue;

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
        .filter(
          (r) =>
            r.dataset &&
            r.metric &&
            typeof r.score === 'number' &&
            !isStubDataset(r.dataset),
        )
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
