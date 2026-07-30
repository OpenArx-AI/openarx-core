import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedSection } from '@openarx/types';
import {
  flattenSections,
  groupIntoBatches,
  sectionsToBatches,
  batchRawContent,
  BATCH_CHAR_LIMIT,
  MIN_SECTION_CHARS,
} from '../section-batching.js';

const sec = (name: string, content: string, subsections: ParsedSection[] = []): ParsedSection =>
  ({ name, content, level: 1, subsections } as unknown as ParsedSection);

test('flattenSections: depth-first with hierarchical paths', () => {
  const flat = flattenSections([sec('A', 'aa', [sec('A1', 'bb')]), sec('B', 'cc')]);
  assert.deepEqual(flat.map((s) => s.path), ['A', 'A > A1', 'B']);
});

test('sectionsToBatches: drops tiny (<MIN) sections, keeps substantive', () => {
  const big = 'x'.repeat(MIN_SECTION_CHARS + 10);
  const batches = sectionsToBatches([sec('tiny', 'ab'), sec('ok', big)]);
  const paths = batches.flat().map((s) => s.path);
  assert.ok(paths.includes('ok'));
  assert.ok(!paths.includes('tiny'));
});

test('groupIntoBatches: packs up to BATCH_CHAR_LIMIT, splits when exceeded', () => {
  const half = 'y'.repeat(Math.floor(BATCH_CHAR_LIMIT * 0.6)); // two of these exceed the limit
  const flat = flattenSections([sec('S1', half), sec('S2', half), sec('S3', half)]);
  const batches = groupIntoBatches(flat);
  assert.ok(batches.length >= 2, 'three 0.6*limit sections must span multiple batches');
  for (const b of batches) {
    // each batch fits the limit unless it is a single oversized section
    const len = b.reduce((n, s) => n + s.content.length, 0);
    assert.ok(len <= BATCH_CHAR_LIMIT || b.length === 1, `batch len ${len} within limit or single-section`);
  }
});

test('groupIntoBatches: overlap carries a small (<=500) last section into the next batch', () => {
  const big = 'z'.repeat(BATCH_CHAR_LIMIT - 100);
  const small = 'w'.repeat(200);
  const flat = flattenSections([sec('BIG', big), sec('SMALL', small), sec('BIG2', big)]);
  const batches = groupIntoBatches(flat);
  // SMALL (<=500) closes batch 1 as its tail and is carried into batch 2 as overlap
  assert.ok(batches.length >= 2);
  const b2paths = batches[1].map((s) => s.path);
  assert.ok(b2paths.includes('SMALL'), 'small tail section carried into next batch');
});

test('batchRawContent: joins section contents by newline, no headers', () => {
  const flat = flattenSections([sec('S1', 'one'), sec('S2', 'two')]);
  assert.equal(batchRawContent(flat), 'one\ntwo');
});
