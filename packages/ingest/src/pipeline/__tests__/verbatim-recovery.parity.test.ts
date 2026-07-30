/**
 * Bit-for-bit parity regression for verbatim-recovery vs the Python reference.
 *
 * Fixtures + golden come from the experimenter (ingest_llm_selection research,
 * .../code/parity): the SAME saved-corpus inputs the Python reference ran on
 * (3587 Stage-1 + 6098 Stage-2 chunks + per-batch coverage). PASS ⇔ this TS port
 * produces per-chunk IDENTICAL (status, span) and per-batch IDENTICAL coverage to
 * Python — the guarantee that the Core recovery matches the validated algorithm.
 *
 * Inputs are gzipped (parsed once by the experimenter, to isolate recovery logic
 * from JSON parsing). No LLM calls. If this fails, the port diverged — do NOT
 * "fix" by adjusting thresholds; re-check the port against vr_lib.py.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { recoverSequence, recoverFromAnchorPairs, coverageCheck } from '../verbatim-recovery.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'parity');
const readGz = <T>(f: string): T => JSON.parse(gunzipSync(readFileSync(join(FX, f))).toString('utf-8')) as T;
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(FX, f), 'utf-8')) as T;

/** golden recovery: per-batch → per-chunk [status, spanStart|null, spanEnd|null]. */
type GoldenRec = Array<Array<[string, number | null, number | null]>>;
/** golden coverage: per-batch [cleanTiling, coveragePct, nGaps, nAllowedDrops, nOverlaps, nFailed]. */
type GoldenCov = Array<[boolean, number, number, number, number, number]>;

const recTriple = (status: string, span: [number, number] | null): [string, number | null, number | null] =>
  [status, span?.[0] ?? null, span?.[1] ?? null];

test('parity D1 (recoverSequence) — per-chunk status/span identical to Python', () => {
  const inputs = readGz<Array<{ content: string; texts: string[] }>>('inputs_d1.json.gz');
  const golden = readJson<GoldenRec>('out_py_d1.json');
  assert.equal(inputs.length, golden.length, 'D1 batch count');
  let nChunks = 0;
  for (let b = 0; b < inputs.length; b++) {
    const res = recoverSequence(inputs[b].texts, inputs[b].content);
    assert.equal(res.length, golden[b].length, `D1 batch ${b} chunk count`);
    for (let c = 0; c < res.length; c++) {
      assert.deepEqual(recTriple(res[c].status, res[c].span), golden[b][c], `D1 batch ${b} chunk ${c}`);
      nChunks++;
    }
  }
  console.log(`  D1 parity: ${inputs.length} batches / ${nChunks} chunks — bit-for-bit`);
});

test('parity D1 coverage — per-batch identical to Python', () => {
  const inputs = readGz<Array<{ content: string; texts: string[] }>>('inputs_d1.json.gz');
  const golden = readJson<GoldenCov>('cov_py_d1.json');
  for (let b = 0; b < inputs.length; b++) {
    const spans = recoverSequence(inputs[b].texts, inputs[b].content).map((r) => r.span);
    const cov = coverageCheck(spans, inputs[b].content);
    const got = [cov.cleanTiling, cov.coveragePct, cov.nGaps, cov.nAllowedDrops, cov.nOverlaps, cov.nFailedChunks];
    assert.deepEqual(got, golden[b], `D1 coverage batch ${b}`);
  }
});

test('parity D3 (recoverFromAnchorPairs) — per-chunk status/span identical to Python', () => {
  const inputs = readGz<Array<{ content: string; pairs: Array<[string, string]> }>>('inputs_d3.json.gz');
  const golden = readJson<GoldenRec>('out_py_d3.json');
  assert.equal(inputs.length, golden.length, 'D3 batch count');
  let nChunks = 0;
  for (let b = 0; b < inputs.length; b++) {
    const res = recoverFromAnchorPairs(inputs[b].pairs, inputs[b].content);
    assert.equal(res.length, golden[b].length, `D3 batch ${b} chunk count`);
    for (let c = 0; c < res.length; c++) {
      assert.deepEqual(recTriple(res[c].status, res[c].span), golden[b][c], `D3 batch ${b} chunk ${c}`);
      nChunks++;
    }
  }
  console.log(`  D3 parity: ${inputs.length} batches / ${nChunks} chunks — bit-for-bit`);
});

test('parity D3 coverage — per-batch identical to Python', () => {
  const inputs = readGz<Array<{ content: string; pairs: Array<[string, string]> }>>('inputs_d3.json.gz');
  const golden = readJson<GoldenCov>('cov_py_d3.json');
  for (let b = 0; b < inputs.length; b++) {
    const spans = recoverFromAnchorPairs(inputs[b].pairs, inputs[b].content).map((r) => r.span);
    const cov = coverageCheck(spans, inputs[b].content);
    const got = [cov.cleanTiling, cov.coveragePct, cov.nGaps, cov.nAllowedDrops, cov.nOverlaps, cov.nFailedChunks];
    assert.deepEqual(got, golden[b], `D3 coverage batch ${b}`);
  }
});
