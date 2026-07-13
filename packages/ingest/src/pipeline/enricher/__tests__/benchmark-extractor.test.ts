/**
 * Regression tests for benchmark extraction garble (openarx-9kv0).
 *
 * Fixtures derive from the SEVERE cases reported by msi:openarx-research
 * (tickets 20260626-114547-0017 / -115527-0021): GROBID tables whose metric
 * column was a task/benchmark-name string that false-matched the 'em' token via
 * the old substring test, glueing a non-metric header into `metric` and the
 * caption "Table N :" into `dataset`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BenchmarkResult, ParsedTable } from '@openarx/types';
import {
  BenchmarkExtractor,
  headerHasMetric,
  isStubDataset,
  columnIsNumeric,
  parseScoreCell,
} from '../benchmark-extractor.js';

// Reach the private table extractor directly — no LLM / pipeline context needed.
function extractTables(tables: ParsedTable[]): BenchmarkResult[] {
  const ex = new BenchmarkExtractor() as unknown as {
    extractFromTables(t: ParsedTable[]): BenchmarkResult[];
  };
  return ex.extractFromTables(tables);
}

test('headerHasMetric: word-boundary, not substring', () => {
  // Real metrics — must match.
  for (const h of ['Accuracy', 'Accuracy (%)', 'F1', 'F1-score', 'mAP', 'EM', 'exact match', 'AUC', 'Recall']) {
    assert.equal(headerHasMetric(h), true, `expected metric: "${h}"`);
  }
  // The 'em'/short-token false positives that caused the bug — must NOT match.
  for (const h of [
    'Memory QA Tasks',
    'Agentic Embodied Interactive Tasks',
    'Overall Single-Hop Multi-Hop Open-Ended Temporal Adversarial',
    'PerMem-Bench s',
    'Method',
    'Model',
  ]) {
    assert.equal(headerHasMetric(h), false, `expected NON-metric: "${h}"`);
  }
});

test('isStubDataset: both placeholder literals', () => {
  for (const s of ['Table 2 :', 'Table 5 :', 'Table 1 :', 'Table 10', 'Not specified', 'N/A', 'unknown', 'none', '-', '', '   ']) {
    assert.equal(isStubDataset(s), true, `expected stub: "${s}"`);
  }
  for (const s of ['ImageNet', 'WebArena', 'LoCoMo-10', 'SQuAD 2.0']) {
    assert.equal(isStubDataset(s), false, `expected real dataset: "${s}"`);
  }
});

test('parseScoreCell + columnIsNumeric', () => {
  assert.equal(parseScoreCell('95.2%'), 95.2);
  assert.equal(parseScoreCell('**88.1**'), 88.1);
  assert.equal(parseScoreCell('0.41 ± 0.1'), 0.41);
  assert.equal(parseScoreCell('2,202'), 2202);
  assert.ok(Number.isNaN(parseScoreCell('MemForest')));
  assert.equal(columnIsNumeric([['a', '1'], ['b', '2'], ['c', 'x']], 1), true);
  assert.equal(columnIsNumeric([['a', 'foo'], ['b', 'bar']], 1), false);
});

test('SEVERE garble fixtures yield ZERO benchmark rows from tables', () => {
  const elasticMem: ParsedTable = {
    caption: 'Table 2 :',
    headers: ['Method', 'Memory QA Tasks', 'Agentic Embodied Interactive Tasks'],
    rows: [
      ['ElasticMem', '0.41', '0.47'],
      ['Baseline', '0.29', '0.44'],
    ],
  };
  const memForest: ParsedTable = {
    caption: 'Table 5 :',
    headers: ['Method', 'Overall Single-Hop Multi-Hop Open-Ended Temporal Adversarial'],
    rows: [['MemForest', '72.3 19.3 40.1'], ['Prev', '19.3 8.1 12.0']],
  };
  const personalize: ParsedTable = {
    caption: 'Table 1 :',
    headers: ['Method', 'PerMem-Bench s', 'PerMem-Bench d'],
    rows: [['PtS', '26', '340'], ['Base', '12', '210']],
  };

  for (const t of [elasticMem, memForest, personalize]) {
    assert.deepEqual(extractTables([t]), [], `garble leaked from: ${t.caption}`);
  }
});

test('CLEAN table is preserved (no over-removal)', () => {
  const clean: ParsedTable = {
    caption: 'Table 3 : Results on standard benchmarks',
    headers: ['Dataset', 'Accuracy', 'F1'],
    rows: [
      ['ImageNet', '95.2', '0.91'],
      ['COCO', '88.1', '0.85'],
    ],
  };
  const rows = extractTables([clean]);
  // 2 datasets × 2 metric columns = 4 rows, all with real dataset + metric.
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(!isStubDataset(r.dataset), `dataset must be real: ${r.dataset}`);
    assert.ok(['Accuracy', 'F1'].includes(r.metric));
    assert.ok(Number.isFinite(r.score));
  }
  const imagenetAcc = rows.find((r) => r.dataset === 'ImageNet' && r.metric === 'Accuracy');
  assert.equal(imagenetAcc?.score, 95.2);
});

test('caption fallback strips "Table N :" prefix but keeps a real dataset name', () => {
  // No dataset column → fall back to caption, minus the "Table N :" prefix.
  const t: ParsedTable = {
    caption: 'Table 4 : ImageNet',
    headers: ['Model', 'Accuracy'],
    rows: [['ResNet', '76.5']],
  };
  const rows = extractTables([t]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset, 'ImageNet');
  assert.equal(rows[0].metric, 'Accuracy');
  assert.equal(rows[0].score, 76.5);
});

test('bare "Table N :" caption with no real dataset is dropped', () => {
  const t: ParsedTable = {
    caption: 'Table 2 :',
    headers: ['Model', 'Accuracy'],
    rows: [['ResNet', '76.5']],
  };
  // Metric is valid but there is no recoverable dataset → drop (no stub emitted).
  assert.deepEqual(extractTables([t]), []);
});
