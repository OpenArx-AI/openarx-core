/**
 * EXPERIMENT HARNESS (openarx-9kv0) — NOT shipped. Safe to delete after the run.
 *
 * Deterministic A/B of the TABLE benchmark extractor (Tier 2) on real production
 * documents, READ-ONLY (never writes `documents`). For each sampled doc it loads
 * the stored GROBID tables (documents.structured_content.tables) and runs BOTH
 * the OLD extractor (substring metric match, embedded verbatim below) and the NEW
 * extractor (word-boundary + numeric-column + stub-dataset drop). No LLM, no
 * nondeterminism — this isolates exactly what the fix changes in table extraction.
 *
 *   tsx src/scripts/exp-benchmark-fix.ts            # default 100 docs
 *   tsx src/scripts/exp-benchmark-fix.ts --n 200
 *
 * Writes experiments/benchmark-fix-100/{per-doc.jsonl,report.md} (repo root).
 */
import { query, pool } from '@openarx/api';
import type { BenchmarkResult, ParsedTable } from '@openarx/types';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkExtractor,
  headerHasMetric,
  isStubDataset,
} from '../pipeline/enricher/benchmark-extractor.js';

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1] ?? 100) || 100;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT_DIR = resolve(REPO_ROOT, 'experiments', 'benchmark-fix-100');

// ── OLD table extractor (verbatim pre-fix logic) ──────────────────────────────
const OLD_METRIC_KEYWORDS = [
  'accuracy', 'acc', 'top-1', 'top-5', 'f1', 'bleu', 'rouge', 'rouge-l', 'map', 'mAP',
  'em', 'exact match', 'perplexity', 'ppl', 'auc', 'precision', 'recall', 'wer', 'cer',
  'meteor', 'cider', 'spice', 'fid', 'is', 'ssim', 'psnr',
];
function oldFindColumn(headers: string[], keywords: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().trim();
    if (keywords.some((k) => h.includes(k))) return i;
  }
  return -1;
}
function oldExtractFromTables(tables: ParsedTable[]): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];
  for (const table of tables) {
    if (!table?.headers || table.headers.length < 2 || !table.rows || table.rows.length === 0) continue;
    const metricCols: Array<{ index: number; metric: string }> = [];
    const datasetCol = oldFindColumn(table.headers, ['dataset', 'benchmark', 'corpus', 'data']);
    const taskCol = oldFindColumn(table.headers, ['task']);
    for (let i = 0; i < table.headers.length; i++) {
      const header = table.headers[i].toLowerCase().trim();
      for (const metric of OLD_METRIC_KEYWORDS) {
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
        const cleaned = scoreStr.replace(/[*%±]/g, '').trim().split(/\s/)[0];
        const score = parseFloat(cleaned);
        if (isNaN(score)) continue;
        results.push({ task: task || '', dataset, metric, score, extractedFrom: 'paper_text' });
      }
    }
  }
  return results;
}

// NEW table extractor — reach the private method, identical to production path.
const extractor = new BenchmarkExtractor() as unknown as {
  extractFromTables(t: ParsedTable[]): BenchmarkResult[];
};
const newExtractFromTables = (t: ParsedTable[]): BenchmarkResult[] => extractor.extractFromTables(t);

const rowKey = (r: BenchmarkResult): string =>
  `${(r.dataset ?? '').trim().toLowerCase()}|${(r.metric ?? '').trim().toLowerCase()}|${
    Math.round(Number(r.score) * 100) / 100
  }`;

/** Classify a row the NEW extractor dropped. */
function removalKind(r: BenchmarkResult): 'garbled_metric' | 'lost_dataset' | 'other' {
  if (!headerHasMetric(String(r.metric ?? ''))) return 'garbled_metric'; // metric is a glued header / task name
  if (isStubDataset(r.dataset)) return 'lost_dataset'; // real metric but only "Table N :" as dataset
  return 'other';
}

interface DocRow {
  id: string;
  source_id: string;
  structured_content: { tables?: ParsedTable[] } | null;
}

async function sampleIds(): Promise<Array<{ id: string; stratum: string }>> {
  const strata: Array<{ stratum: string; sql: string; limit: number }> = [
    {
      stratum: 'dataset_tableN',
      limit: Math.round(N * 0.45),
      sql: `SELECT DISTINCT d.id FROM documents d, jsonb_array_elements(d.benchmark_results) e
            WHERE jsonb_typeof(d.benchmark_results)='array' AND e->>'dataset' ~* '^\\s*table\\s*[0-9]'
            ORDER BY d.id LIMIT $1`,
    },
    {
      stratum: 'metric_no_token',
      limit: Math.round(N * 0.25),
      sql: `SELECT DISTINCT d.id FROM documents d, jsonb_array_elements(d.benchmark_results) e
            WHERE jsonb_typeof(d.benchmark_results)='array'
              AND array_length(regexp_split_to_array(btrim(e->>'metric'),'\\s+'),1) >= 4
            ORDER BY d.id DESC LIMIT $1`,
    },
    {
      stratum: 'clean_with_tables',
      limit: Math.round(N * 0.3),
      sql: `SELECT d.id FROM documents d
            WHERE jsonb_typeof(d.benchmark_results)='array' AND jsonb_array_length(d.benchmark_results) > 0
              AND jsonb_typeof(d.structured_content->'tables')='array'
              AND jsonb_array_length(d.structured_content->'tables') >= 2
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(d.benchmark_results) e
                WHERE e->>'dataset' ~* '^\\s*table' OR lower(e->>'dataset')='not specified')
            ORDER BY d.id LIMIT $1`,
    },
  ];
  const seen = new Set<string>();
  const out: Array<{ id: string; stratum: string }> = [];
  for (const s of strata) {
    const { rows } = await query<{ id: string }>(s.sql, [s.limit]);
    for (const r of rows) {
      if (!seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, stratum: s.stratum }); }
    }
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const ids = await sampleIds();
  console.log(`Sampled ${ids.length} docs. Deterministic table A/B...`);

  const perDoc: unknown[] = [];
  const agg = {
    docs: 0,
    byStratum: {} as Record<string, number>,
    oldRows: 0,
    newRows: 0,
    removed: 0,
    removedGarbledMetric: 0,
    removedLostDataset: 0,
    removedOther: 0,
    added: 0,
    preserved: 0,
    docsAllGarble: 0, // doc where old produced rows, ALL removed by new
  };
  const examples: unknown[] = [];

  for (let i = 0; i < ids.length; i++) {
    const { id, stratum } = ids[i];
    const { rows } = await query<DocRow>(
      `SELECT id, source_id, structured_content FROM documents WHERE id=$1`, [id]);
    const doc = rows[0];
    if (!doc) continue;
    const tables = doc.structured_content?.tables ?? [];

    const oldRows = oldExtractFromTables(tables);
    const newRows = newExtractFromTables(tables);
    const newKeys = new Set(newRows.map(rowKey));
    const oldKeys = new Set(oldRows.map(rowKey));
    const removed = oldRows.filter((r) => !newKeys.has(rowKey(r)));
    const added = newRows.filter((r) => !oldKeys.has(rowKey(r)));
    const preserved = oldRows.filter((r) => newKeys.has(rowKey(r)));

    const kinds = { garbled_metric: 0, lost_dataset: 0, other: 0 };
    for (const r of removed) kinds[removalKind(r)]++;

    agg.docs++;
    agg.byStratum[stratum] = (agg.byStratum[stratum] ?? 0) + 1;
    agg.oldRows += oldRows.length;
    agg.newRows += newRows.length;
    agg.removed += removed.length;
    agg.removedGarbledMetric += kinds.garbled_metric;
    agg.removedLostDataset += kinds.lost_dataset;
    agg.removedOther += kinds.other;
    agg.added += added.length;
    agg.preserved += preserved.length;
    if (oldRows.length > 0 && newRows.length === 0) agg.docsAllGarble++;

    perDoc.push({
      id, sourceId: doc.source_id, stratum,
      old: oldRows.length, new: newRows.length,
      removed: removed.length, ...kinds, added: added.length, preserved: preserved.length,
    });

    if (examples.length < 10 && removed.length > 0) {
      examples.push({
        sourceId: doc.source_id, stratum,
        removedSample: removed.slice(0, 3),
        preservedSample: preserved.slice(0, 2),
      });
    }
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${ids.length}`);
  }

  writeFileSync(resolve(OUT_DIR, 'per-doc.jsonl'), perDoc.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const md = [
    `# Benchmark table-extractor fix — deterministic A/B (openarx-9kv0)`,
    ``,
    `Sample **${agg.docs} docs** · strata: ${Object.entries(agg.byStratum).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `Method: OLD vs NEW \`extractFromTables\` on the same stored GROBID tables. No LLM, fully deterministic.`,
    ``,
    `| metric | value |`,
    `|---|---:|`,
    `| OLD table rows produced | ${agg.oldRows} |`,
    `| NEW table rows produced | ${agg.newRows} |`,
    `| rows REMOVED by fix | **${agg.removed}** (${pct(agg.removed, agg.oldRows)} of old) |`,
    `| ├ garbled metric (no real metric token) | ${agg.removedGarbledMetric} |`,
    `| ├ lost dataset ("Table N :" only) | ${agg.removedLostDataset} |`,
    `| └ other | ${agg.removedOther} |`,
    `| rows PRESERVED (real metric + real dataset) | ${agg.preserved} |`,
    `| rows ADDED by fix | ${agg.added} |`,
    `| docs whose table rows were ALL garble → 0 | ${agg.docsAllGarble} |`,
    ``,
    `**Reading:** removed = garble the fix strips from tables. Preserved = legit table`,
    `benchmarks kept untouched. Tier-3 (LLM) rows are not produced by table extraction,`,
    `so they are out of scope here and unaffected by this change.`,
    ``,
    `## Concrete removed/preserved examples`,
    '```json',
    JSON.stringify(examples, null, 2),
    '```',
  ].join('\n');
  writeFileSync(resolve(OUT_DIR, 'report.md'), md);
  console.log('\n' + md.split('## Concrete')[0]);
  await pool.end();
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${((n / total) * 100).toFixed(1)}%`;
}

main().catch((e) => { console.error('experiment failed:', e); process.exit(1); });
