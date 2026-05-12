/**
 * Unit tests for vector-store pure helpers.
 *
 * Integration tests (real Qdrant roundtrip, payload decoding) live in the
 * Phase 2 smoke script — this file covers the filter-merging contract so
 * changes to mergeLatestGuard visibly break if someone drops the F3
 * is_latest invariant or mishandles caller-provided must/must_not.
 *
 * Soft-delete used to be a Qdrant-layer guard here; removed 2026-05-09
 * (openarx-g5t6) due to empty payload index causing 5.5s/query overhead.
 * Soft-delete is now enforced exclusively at the PG layer — see
 * mergeLatestGuard comment for the upstream filter sites.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeLatestGuard, type MergedFilter } from '../vector-store.js';

const IS_LATEST_GUARD = { key: 'is_latest', match: { value: true } };

test('mergeLatestGuard — undefined filter yields is_latest invariant only', () => {
  const result: MergedFilter = mergeLatestGuard(undefined);
  assert.deepEqual(result.must, [IS_LATEST_GUARD]);
  assert.deepEqual(result.must_not, []);
});

test('mergeLatestGuard — preserves caller must[] + appends is_latest', () => {
  const result: MergedFilter = mergeLatestGuard({
    must: [{ key: 'document_id', match: { value: 'abc' } }],
  });
  assert.deepEqual(result.must, [
    { key: 'document_id', match: { value: 'abc' } },
    IS_LATEST_GUARD,
  ]);
  assert.deepEqual(result.must_not, []);
});

test('mergeLatestGuard — preserves caller must_not[] without injection', () => {
  const result: MergedFilter = mergeLatestGuard({
    must_not: [{ key: 'concept_id', match: { value: 'self-concept' } }],
  });
  assert.deepEqual(result.must, [IS_LATEST_GUARD]);
  assert.deepEqual(result.must_not, [
    { key: 'concept_id', match: { value: 'self-concept' } },
  ]);
});

test('mergeLatestGuard — combines caller must + must_not with is_latest', () => {
  const result: MergedFilter = mergeLatestGuard({
    must: [{ key: 'document_title', match: { value: 'Paper X' } }],
    must_not: [{ key: 'concept_id', match: { value: 'self' } }],
  });
  assert.deepEqual(result.must, [
    { key: 'document_title', match: { value: 'Paper X' } },
    IS_LATEST_GUARD,
  ]);
  assert.deepEqual(result.must_not, [
    { key: 'concept_id', match: { value: 'self' } },
  ]);
});

test('mergeLatestGuard — empty caller must_not stays empty', () => {
  const result: MergedFilter = mergeLatestGuard({
    must: [{ key: 'k', match: { value: 'v' } }],
    must_not: [],
  });
  assert.deepEqual(result.must_not, []);
});
