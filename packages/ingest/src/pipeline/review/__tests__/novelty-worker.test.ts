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
  extractIdentifiersFromText,
  hasReferencesSection,
  resolveGroundingScore,
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

// ─── extractIdentifiersFromText (openarx-contracts-0skd) ──────────────────

test('extractIdentifiersFromText — arxiv URL/bare + doi.org/prefix/bare', () => {
  const text = `
## References
[1] Wang Y., Sun L. "A Survey." arxiv.org/abs/2401.12345
[2] Lee K. https://arxiv.org/abs/2110.11331v2
[3] Patel R. arXiv: 2305.09999
[4] Smith J. doi.org/10.1145/3456789
[5] Doe A. DOI: 10.1000/journal.2023.42
[6] Roe B. bare 10.5555/abc-123 in paragraph.
`;
  const { dois, arxivIds } = extractIdentifiersFromText(text);
  assert.deepEqual(arxivIds.sort(), ['2110.11331', '2305.09999', '2401.12345']);
  assert.deepEqual(dois.sort(), ['10.1000/journal.2023.42', '10.1145/3456789', '10.5555/abc-123']);
});

test('extractIdentifiersFromText — strips version suffix, dedupes, lowercases DOI', () => {
  const text = 'see arxiv.org/abs/2401.12345v3 and arxiv:2401.12345; DOI: 10.1145/ABC and doi.org/10.1145/abc.';
  const { dois, arxivIds } = extractIdentifiersFromText(text);
  assert.deepEqual(arxivIds, ['2401.12345']);
  assert.deepEqual(dois, ['10.1145/abc']); // trailing '.' stripped, case-folded, deduped
});

test('extractIdentifiersFromText — title-only references yield nothing', () => {
  const text = '## References\n[1] Knuth D. The Art of Computer Programming. Addison-Wesley, 1968.\n[2] Lamport L. LaTeX: A Document Preparation System. 1994.';
  const { dois, arxivIds, oarxIds } = extractIdentifiersFromText(text);
  assert.deepEqual(dois, []);
  assert.deepEqual(arxivIds, []);
  assert.deepEqual(oarxIds, []);
});

test('extractIdentifiersFromText — OpenArx oarx_id: bare, legacy 8-hex, and in a URL', () => {
  const text = '[1] OpenArx paper oarx-0e38fdf76f117ca9; [2] legacy oarx-deadbeef; [3] openarx.com/oarx-1234567890abcdef';
  const { oarxIds } = extractIdentifiersFromText(text);
  assert.deepEqual(oarxIds.sort(), ['oarx-0e38fdf76f117ca9', 'oarx-1234567890abcdef', 'oarx-deadbeef']);
});

test('extractIdentifiersFromText — oarx_id uppercased is normalized to lowercase', () => {
  const { oarxIds } = extractIdentifiersFromText('See OARX-0E38FDF76F117CA9 for details.');
  assert.deepEqual(oarxIds, ['oarx-0e38fdf76f117ca9']);
});

test('extractIdentifiersFromText — wrong-length oarx-like token is ignored', () => {
  // 12 hex chars — neither the 16-hex new format nor the 8-hex legacy format
  const { oarxIds } = extractIdentifiersFromText('oarx-0e38fdf76f11 is not a valid id');
  assert.deepEqual(oarxIds, []);
});

// ─── hasReferencesSection (openarx-contracts-0skd) ───────────────────────

test('hasReferencesSection — markdown headings (References/Bibliography/Works Cited)', () => {
  assert.equal(hasReferencesSection('# Intro\n...\n## References\n[1] x'), true);
  assert.equal(hasReferencesSection('## Bibliography'), true);
  assert.equal(hasReferencesSection('Works Cited'), true);
  assert.equal(hasReferencesSection('### References:'), true);
});

test('hasReferencesSection — three or more numbered ref lines', () => {
  assert.equal(hasReferencesSection('[1] a\n[2] b\n[3] c'), true);
  assert.equal(hasReferencesSection('[1] a\n[2] b'), false); // only two
});

test('hasReferencesSection — prose mentioning references is not a section', () => {
  assert.equal(hasReferencesSection('We build on prior references to attention models.'), false);
  assert.equal(hasReferencesSection(''), false);
});

// ─── resolveGroundingScore — NULL/0 semantics (openarx-contracts-0skd) ────

test('resolveGroundingScore — cited present, overlap → ratio (acceptance 1)', () => {
  const r = resolveGroundingScore({
    hasCitedIdentifiers: true, hasReferencesSection: true,
    citedDocIds: new Set(['a', 'b']), similarDocIds: new Set(['a', 'c']),
  });
  assert.equal(r.score, 0.5);
  assert.equal(r.reason, 'computed');
});

test('resolveGroundingScore — cited empty + references section → NULL not 0 (acceptance 2)', () => {
  const r = resolveGroundingScore({
    hasCitedIdentifiers: false, hasReferencesSection: true,
    citedDocIds: new Set(), similarDocIds: new Set(['a', 'b']),
  });
  assert.equal(r.score, null);
  assert.equal(r.reason, 'references_present_but_unparsed');
});

test('resolveGroundingScore — cited empty + no references section → NULL (acceptance 3)', () => {
  const r = resolveGroundingScore({
    hasCitedIdentifiers: false, hasReferencesSection: false,
    citedDocIds: new Set(), similarDocIds: new Set(['a', 'b']),
  });
  assert.equal(r.score, null);
  assert.equal(r.reason, 'no_references_section');
});

test('resolveGroundingScore — cited present but |similar|=0 → NULL (acceptance 4)', () => {
  const r = resolveGroundingScore({
    hasCitedIdentifiers: true, hasReferencesSection: true,
    citedDocIds: new Set(['a']), similarDocIds: new Set(),
  });
  assert.equal(r.score, null);
  assert.equal(r.reason, 'no_similar_docs');
});

test('resolveGroundingScore — cited present, similar present, zero intersection → 0.0 (acceptance 5)', () => {
  const r = resolveGroundingScore({
    hasCitedIdentifiers: true, hasReferencesSection: true,
    citedDocIds: new Set(['x']), similarDocIds: new Set(['a', 'b']),
  });
  assert.equal(r.score, 0.0);
  assert.equal(r.reason, 'computed');
});

// ─── szpw: is_cited flag + near-duplicate / novelty gating ───────────────

test('buildSimilarDocuments — cited high-sim → is_cited true, is_near_duplicate false; uncited high-sim stays true (acceptance 1/4)', () => {
  const agg = new Map([
    ['cited', { documentId: 'cited', maxSim: 0.95, matchedSectionCount: 3, isNearDuplicate: true }],
    ['uncited', { documentId: 'uncited', maxSim: 0.92, matchedSectionCount: 2, isNearDuplicate: true }],
  ]);
  const result = buildSimilarDocuments(agg, new Map(), 0.75, 10, new Set(['cited']));
  const cited = result.find((r) => r.document_id === 'cited')!;
  const uncited = result.find((r) => r.document_id === 'uncited')!;
  assert.equal(cited.is_cited, true);
  assert.equal(cited.is_near_duplicate, false); // citation justifies the overlap
  assert.equal(cited.similarity, 0.95);         // raw similarity preserved
  assert.equal(uncited.is_cited, false);
  assert.equal(uncited.is_near_duplicate, true); // real near-duplicate preserved
});

test('buildSimilarDocuments — no cited set → is_cited false, raw is_near_duplicate kept (acceptance 3/5)', () => {
  const agg = new Map([
    ['plag', { documentId: 'plag', maxSim: 0.93, matchedSectionCount: 1, isNearDuplicate: true }],
  ]);
  const result = buildSimilarDocuments(agg, new Map(), 0.75, 10); // citedDocIds omitted (legacy callers)
  assert.equal(result[0].is_cited, false);
  assert.equal(result[0].is_near_duplicate, true); // uncited plagiarism case preserved
});

test('computeNovelty — excludes cited neighbours from per-chunk max (szpw)', () => {
  // chunk 1: cited@0.95 + uncited@0.60 → exclude cited → max 0.60 → novelty 0.40
  // chunk 2: only cited@0.90 → no non-cited neighbour → full novelty 1.0
  const result = computeNovelty([
    [fakeResult('cited', 0.95), fakeResult('uncited', 0.60)],
    [fakeResult('cited', 0.90)],
  ], new Set(['cited']));
  assert.ok(Math.abs(result - 0.70) < 1e-9, `got ${result}`); // median([0.40, 1.0])
});

test('computeNovelty — excluding cited raises novelty vs not excluding (acceptance 2)', () => {
  const batch = [[fakeResult('cited', 0.95), fakeResult('other', 0.50)]];
  const withExclusion = computeNovelty(batch, new Set(['cited'])); // max 0.50 → 0.50
  const without = computeNovelty(batch);                           // max 0.95 → 0.05
  assert.ok(withExclusion > without, `${withExclusion} should exceed ${without}`);
  assert.ok(Math.abs(withExclusion - 0.50) < 1e-9, `got ${withExclusion}`);
});
