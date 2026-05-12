/**
 * Unit tests for Aspect 3 pure functions.
 * End-to-end integration (real Qdrant + PG) lives in the Phase 2 smoke
 * script on S1; these tests lock down the math + deterministic sampling.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SearchResult, ParsedReference } from '@openarx/types';
import {
  strideSample,
  median,
  computeNovelty,
  aggregateSimilarDocs,
  buildSimilarDocuments,
  computeGrounding,
  extractCitedIdentifiers,
} from '../novelty-worker.js';

// ─── strideSample ─────────────────────────────────────────────

test('strideSample — len < cap returns all', () => {
  assert.deepEqual(strideSample([1, 2, 3], 10), [1, 2, 3]);
});

test('strideSample — exact match returns all', () => {
  assert.deepEqual(strideSample([1, 2, 3], 3), [1, 2, 3]);
});

test('strideSample — len > cap strides deterministically', () => {
  // 10 items, cap=3 → stride=ceil(10/3)=4 → indices 0, 4, 8
  const result = strideSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
  assert.deepEqual(result, [0, 4, 8]);
});

test('strideSample — len=1000 cap=100 stride=10 picks first of each decile', () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const result = strideSample(items, 100);
  assert.equal(result.length, 100);
  assert.equal(result[0], 0);
  assert.equal(result[1], 10);
  assert.equal(result[99], 990);
});

test('strideSample — deterministic across calls', () => {
  const items = Array.from({ length: 500 }, (_, i) => i);
  assert.deepEqual(strideSample(items, 100), strideSample(items, 100));
});

// ─── median ─────────────────────────────────────────────

test('median — empty', () => {
  assert.equal(median([]), 0);
});

test('median — single element', () => {
  assert.equal(median([5]), 5);
});

test('median — odd length', () => {
  assert.equal(median([3, 1, 5, 7, 9]), 5);
});

test('median — even length averages middle two', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// ─── computeNovelty ─────────────────────────────────────────────

function fakeResult(docId: string, score: number): SearchResult {
  return {
    chunkId: `chunk-${docId}`,
    documentId: docId,
    content: '',
    context: {
      documentTitle: '', sectionName: undefined, sectionPath: undefined,
      positionInDocument: 0, totalChunks: 1,
    },
    score,
  };
}

test('computeNovelty — empty batch → 1.0', () => {
  assert.equal(computeNovelty([]), 1.0);
});

test('computeNovelty — empty per-query results contribute 1.0', () => {
  assert.equal(computeNovelty([[], [], []]), 1.0);
});

test('computeNovelty — single query with high similarity → low novelty', () => {
  const result = computeNovelty([[fakeResult('a', 0.95)]]);
  assert.ok(Math.abs(result - 0.05) < 1e-9, `got ${result}`);
});

test('computeNovelty — median over mixed similarities', () => {
  // max per chunk: [0.9, 0.7, 0.5] → novelty per chunk: [0.1, 0.3, 0.5]
  // median = 0.3
  const result = computeNovelty([
    [fakeResult('a', 0.9)],
    [fakeResult('b', 0.7)],
    [fakeResult('c', 0.5)],
  ]);
  assert.ok(Math.abs(result - 0.3) < 1e-9, `got ${result}`);
});

test('computeNovelty — takes max per query (multiple neighbours)', () => {
  // query 1: [0.8, 0.95, 0.3] → max=0.95 → novelty=0.05
  // query 2: [0.6] → novelty=0.4
  // median=[0.05, 0.4] → 0.225
  const result = computeNovelty([
    [fakeResult('a', 0.8), fakeResult('b', 0.95), fakeResult('c', 0.3)],
    [fakeResult('d', 0.6)],
  ]);
  assert.ok(Math.abs(result - 0.225) < 1e-9, `got ${result}`);
});

// ─── aggregateSimilarDocs ─────────────────────────────────────────────

test('aggregateSimilarDocs — single-chunk per-doc max', () => {
  const agg = aggregateSimilarDocs([
    [fakeResult('a', 0.85), fakeResult('b', 0.5)],
    [fakeResult('a', 0.92), fakeResult('c', 0.4)],
  ]);
  assert.equal(agg.size, 3);
  assert.equal(agg.get('a')!.maxSim, 0.92);
  assert.equal(agg.get('a')!.matchedSectionCount, 2);
  assert.equal(agg.get('a')!.isNearDuplicate, true); // 0.92 > T_DUP=0.90
  assert.equal(agg.get('b')!.maxSim, 0.5);
  assert.equal(agg.get('b')!.matchedSectionCount, 1);
  assert.equal(agg.get('b')!.isNearDuplicate, false);
});

test('aggregateSimilarDocs — dup hit within same sample counted once', () => {
  // One sample returns same doc twice (A's two chunks) — matchedSectionCount
  // for A should be 1, not 2, because it's the same source sample.
  const agg = aggregateSimilarDocs([[fakeResult('a', 0.8), fakeResult('a', 0.9)]]);
  assert.equal(agg.get('a')!.matchedSectionCount, 1);
  assert.equal(agg.get('a')!.maxSim, 0.9);
});

test('aggregateSimilarDocs — empty batch', () => {
  assert.equal(aggregateSimilarDocs([]).size, 0);
});

// ─── buildSimilarDocuments ─────────────────────────────────────────────

test('buildSimilarDocuments — filters below T_overlap, sorts, caps top-N', () => {
  const agg = new Map([
    ['a', { documentId: 'a', maxSim: 0.80, matchedSectionCount: 5, isNearDuplicate: false }],
    ['b', { documentId: 'b', maxSim: 0.92, matchedSectionCount: 2, isNearDuplicate: true }],
    ['c', { documentId: 'c', maxSim: 0.60, matchedSectionCount: 10, isNearDuplicate: false }], // below T_overlap
    ['d', { documentId: 'd', maxSim: 0.76, matchedSectionCount: 1, isNearDuplicate: false }],
  ]);
  const metadata = new Map([
    ['a', { title: 'Paper A', authors: ['Alice'] }],
    ['b', { title: 'Paper B', authors: null }],
    ['d', { title: null, authors: null }],
  ]);
  const result = buildSimilarDocuments(agg, metadata, 0.75, 10);
  assert.equal(result.length, 3);
  // Sort by maxSim desc: b(0.92), a(0.80), d(0.76)
  assert.equal(result[0].document_id, 'b');
  assert.equal(result[0].similarity, 0.92);
  assert.equal(result[0].is_near_duplicate, true);
  assert.equal(result[1].document_id, 'a');
  assert.equal(result[1].title, 'Paper A');
  assert.deepEqual(result[1].authors, ['Alice']);
  assert.equal(result[2].document_id, 'd');
  // c excluded (0.60 < 0.75)
});

test('buildSimilarDocuments — top-10 cap', () => {
  const agg = new Map(
    Array.from({ length: 20 }, (_, i) => [
      `doc${i}`,
      { documentId: `doc${i}`, maxSim: 0.8 + i * 0.005, matchedSectionCount: 1, isNearDuplicate: false },
    ]),
  );
  const result = buildSimilarDocuments(agg, new Map(), 0.75, 10);
  assert.equal(result.length, 10);
});

// ─── computeGrounding ─────────────────────────────────────────────

test('computeGrounding — empty similar set → null', () => {
  assert.equal(computeGrounding(new Set(['a', 'b']), new Set()), null);
});

test('computeGrounding — full overlap = 1.0', () => {
  assert.equal(computeGrounding(new Set(['a', 'b']), new Set(['a', 'b'])), 1.0);
});

test('computeGrounding — no overlap = 0.0', () => {
  assert.equal(computeGrounding(new Set(['x']), new Set(['a', 'b'])), 0.0);
});

test('computeGrounding — partial overlap', () => {
  // 2 of 4 similar are cited → 0.5
  assert.equal(
    computeGrounding(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd'])),
    0.5,
  );
});

// ─── extractCitedIdentifiers ─────────────────────────────────────────────

test('extractCitedIdentifiers — DOI lowercased + deduped', () => {
  const refs: ParsedReference[] = [
    { raw: 'ref1', doi: '10.1234/ABC' },
    { raw: 'ref2', doi: '10.1234/abc' }, // dup after lowercase
    { raw: 'ref3', doi: '10.5555/XYZ' },
  ];
  const result = extractCitedIdentifiers(refs);
  assert.deepEqual(result.dois.sort(), ['10.1234/abc', '10.5555/xyz']);
});

test('extractCitedIdentifiers — arxiv URL pattern', () => {
  const refs: ParsedReference[] = [
    { raw: 'Foo', url: 'https://arxiv.org/abs/2103.13455' },
    { raw: 'Bar arxiv.org/pdf/2110.11331 ' }, // in raw text
    { raw: 'old-style', url: 'https://arxiv.org/abs/cs.LG/0405001' },
  ];
  const result = extractCitedIdentifiers(refs);
  assert.ok(result.arxivIds.includes('2103.13455'), `missing 2103: ${result.arxivIds}`);
  assert.ok(result.arxivIds.includes('2110.11331'), `missing 2110: ${result.arxivIds}`);
  assert.ok(result.arxivIds.includes('cs.lg/0405001'), `missing cs.lg: ${result.arxivIds}`);
});

test('extractCitedIdentifiers — ignores refs without DOI or arxiv URL', () => {
  const refs: ParsedReference[] = [
    { raw: 'book title, publisher, year' },
    { raw: 'Foo 2023, https://example.com/paper.pdf' },
  ];
  const result = extractCitedIdentifiers(refs);
  assert.deepEqual(result.dois, []);
  assert.deepEqual(result.arxivIds, []);
});
