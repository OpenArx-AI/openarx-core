/**
 * Single-date-anchor + direction semantics for registry selection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateBounds } from './date-bounds.js';

test('lone date + backward → anchor becomes the UPPER bound (walk back from it)', () => {
  assert.deepEqual(resolveDateBounds('2023-12-31', undefined, 'backward'), { upper: '2023-12-31' });
});

test('lone date + forward → anchor becomes the LOWER bound (walk forward from it)', () => {
  assert.deepEqual(resolveDateBounds('2023-12-31', undefined, 'forward'), { lower: '2023-12-31' });
});

test('lone date passed via dateTo is still treated as the anchor', () => {
  assert.deepEqual(resolveDateBounds(undefined, '2023-12-31', 'backward'), { upper: '2023-12-31' });
  assert.deepEqual(resolveDateBounds(undefined, '2023-12-31', 'forward'), { lower: '2023-12-31' });
});

test('both dates → explicit range; direction does NOT move the bounds', () => {
  assert.deepEqual(resolveDateBounds('2023-01-01', '2023-12-31', 'backward'), { lower: '2023-01-01', upper: '2023-12-31' });
  assert.deepEqual(resolveDateBounds('2023-01-01', '2023-12-31', 'forward'), { lower: '2023-01-01', upper: '2023-12-31' });
});

test('neither date → no bounds (downloaded-backlog-only run)', () => {
  assert.deepEqual(resolveDateBounds(undefined, undefined, 'backward'), {});
  assert.deepEqual(resolveDateBounds(undefined, undefined, 'forward'), {});
});
