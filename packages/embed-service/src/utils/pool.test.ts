import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapConcurrent } from './pool.js';

test('mapConcurrent: preserves order', async () => {
  const items = [100, 50, 10, 30, 80];
  const results = await mapConcurrent(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 2;
  });
  assert.deepEqual(results, [200, 100, 20, 60, 160]);
});

test('mapConcurrent: respects concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const items = new Array(20).fill(0);
  await mapConcurrent(items, 4, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  });
  assert.ok(maxActive <= 4, `maxActive=${maxActive}`);
  assert.ok(maxActive >= 3, `expected at least 3 parallel, got ${maxActive}`);
});

test('mapConcurrent: empty array', async () => {
  const r = await mapConcurrent([], 4, async () => 1);
  assert.deepEqual(r, []);
});
