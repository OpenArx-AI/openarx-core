/**
 * Soft-filter behaviour for chunk contentType (openarx-86pv).
 *
 * Background: pre-2026-05 chunker did not reliably populate contentType.
 * About 17% of legacy chunks have it; the rest are null. A strict equality
 * filter silently dropped these chunks from MCP results, so an agent
 * filtering by contentType=['methodology'] on a 65-chunk paper could see
 * just 6 chunks back when 60 were retrievable. Soft-filter keeps the null
 * chunks in the result as an "unknown" tier, sorted after explicit matches.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ChunkContext } from '@openarx/types';
import {
  applyChunkContextFilters,
  countUnknownContentType,
  type RankedChunk,
} from '../search-helpers.js';

function makeChunk(
  id: string,
  ctx: Partial<ChunkContext>,
  score = 0,
): RankedChunk {
  return {
    chunkId: id,
    documentId: 'doc',
    content: '',
    context: ctx as ChunkContext,
    vectorScore: score,
    bm25Score: score,
    finalScore: score,
  };
}

test('soft-filter: matched chunks come before unknown-tier chunks', () => {
  const chunks = [
    makeChunk('a', { contentType: 'methodology' }),
    makeChunk('b', {}), // null contentType
    makeChunk('c', { contentType: 'methodology' }),
    makeChunk('d', {}), // null
  ];
  const result = applyChunkContextFilters(chunks, { contentType: ['methodology'] });
  assert.equal(result.length, 4);
  assert.deepEqual(result.map((c) => c.chunkId), ['a', 'c', 'b', 'd']);
});

test('soft-filter: explicit mismatch contentType is excluded', () => {
  const chunks = [
    makeChunk('a', { contentType: 'methodology' }),
    makeChunk('b', { contentType: 'results' }),
    makeChunk('c', {}),
  ];
  const result = applyChunkContextFilters(chunks, { contentType: ['methodology'] });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((c) => c.chunkId), ['a', 'c']);
});

test('soft-filter: ProcMEM-style scenario (6 matched + 54 unknown + 5 mismatch)', () => {
  const chunks: RankedChunk[] = [];
  for (let i = 0; i < 6; i++) chunks.push(makeChunk(`m${i}`, { contentType: 'methodology' }));
  for (let i = 0; i < 54; i++) chunks.push(makeChunk(`u${i}`, {})); // null
  for (let i = 0; i < 5; i++) chunks.push(makeChunk(`r${i}`, { contentType: 'results' }));

  const result = applyChunkContextFilters(chunks, { contentType: ['methodology'] });
  assert.equal(result.length, 60, 'returns matched + unknown, drops explicit mismatch');
  assert.equal(result.slice(0, 6).every((c) => c.chunkId.startsWith('m')), true);
  assert.equal(result.slice(6).every((c) => c.chunkId.startsWith('u')), true);
  assert.equal(countUnknownContentType(result), 54);
});

test('soft-filter: no filter returns input unchanged', () => {
  const chunks = [
    makeChunk('a', { contentType: 'methodology' }),
    makeChunk('b', {}),
    makeChunk('c', { contentType: 'results' }),
  ];
  const result = applyChunkContextFilters(chunks, {});
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((c) => c.chunkId), ['a', 'b', 'c']);
});

test('soft entities: match first, null/empty entities kept at bottom, non-matching dropped', () => {
  const chunks = [
    makeChunk('a', { entities: ['BERT', 'GPT'] }),   // match -> top
    makeChunk('b', {}),                               // null entities -> unknown (kept, bottom)
    makeChunk('c', { entities: ['GPT'] }),            // match -> top
    makeChunk('d', { entities: ['ResNet'] }),         // has entities, no match -> DROPPED
    makeChunk('e', { entities: [] }),                 // empty entities -> unknown (kept, bottom)
  ];
  const result = applyChunkContextFilters(chunks, { entities: ['GPT'] });
  // a,c matched (top), then b,e unknown (bottom); d dropped
  assert.deepEqual(result.map((c) => c.chunkId), ['a', 'c', 'b', 'e']);
});

test('soft entities: no-filter returns all unchanged', () => {
  const chunks = [
    makeChunk('a', { entities: ['BERT'] }),
    makeChunk('b', {}),
  ];
  const result = applyChunkContextFilters(chunks, {});
  assert.deepEqual(result.map((c) => c.chunkId), ['a', 'b']);
});

test('soft contentType + soft entities combined: tiers + drops', () => {
  const chunks = [
    makeChunk('a', { contentType: 'methodology', entities: ['BERT'] }),  // both match -> matched
    makeChunk('b', { contentType: 'methodology' }),                       // ct match, entities null -> unknown
    makeChunk('c', { entities: ['BERT'] }),                               // ct null, entities match -> unknown
    makeChunk('d', { contentType: 'results', entities: ['BERT'] }),       // ct mismatch -> DROPPED
    makeChunk('e', {}),                                                   // both null -> unknown
    makeChunk('f', { contentType: 'methodology', entities: ['ResNet'] }), // ct match, entities mismatch -> DROPPED
  ];
  const result = applyChunkContextFilters(chunks, {
    contentType: ['methodology'],
    entities: ['BERT'],
  });
  // matched tier: a (both match). unknown tier: b, c, e. dropped: d, f.
  assert.equal(result.length, 4);
  assert.equal(result[0].chunkId, 'a');
  assert.deepEqual(result.slice(1).map((c) => c.chunkId).sort(), ['b', 'c', 'e']);
});

test('case-insensitive contentType matching', () => {
  const chunks = [
    makeChunk('a', { contentType: 'Methodology' }),
    makeChunk('b', { contentType: 'METHODOLOGY' }),
  ];
  const result = applyChunkContextFilters(chunks, { contentType: ['methodology'] });
  assert.equal(result.length, 2);
});

test('countUnknownContentType: counts only null/missing contentType', () => {
  const chunks = [
    makeChunk('a', { contentType: 'methodology' }),
    makeChunk('b', {}),
    makeChunk('c', { contentType: 'results' }),
    makeChunk('d', {}),
  ];
  assert.equal(countUnknownContentType(chunks), 2);
});
