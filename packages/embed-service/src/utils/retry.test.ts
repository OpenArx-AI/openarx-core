import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { retry, vertexBackoff } from './retry.js';

test('vertexBackoff: 429 → long schedule (>=4s on first attempt)', () => {
  const err = new Error('Vertex embedContent failed (429): quota exceeded');
  for (let i = 0; i < 10; i++) {
    const delay = vertexBackoff(err, 0);
    assert.ok(delay >= 4000 && delay <= 6000, `attempt 0 delay=${delay}`);
  }
});

test('vertexBackoff: 429 escalates (5s → 30s → 120s)', () => {
  const err = new Error('Vertex failed (429)');
  const d0 = vertexBackoff(err, 0);
  const d1 = vertexBackoff(err, 1);
  const d2 = vertexBackoff(err, 2);
  assert.ok(d0 >= 4000 && d0 <= 6000, `d0=${d0}`);
  assert.ok(d1 >= 24000 && d1 <= 36000, `d1=${d1}`);
  assert.ok(d2 >= 96000 && d2 <= 144000, `d2=${d2}`);
});

test('vertexBackoff: non-429 uses standard exponential (<10s)', () => {
  const err = new Error('Vertex failed (500): upstream error');
  for (let i = 0; i < 10; i++) {
    const delay = vertexBackoff(err, 0);
    assert.ok(delay <= 8000, `attempt 0 delay=${delay}`);
  }
});

test('retry: custom backoff is honoured', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const t0 = Date.now();
  try {
    await retry(
      async () => { attempts++; throw new Error('x'); },
      { retries: 2, backoff: () => { delays.push(50); return 50; } },
    );
  } catch { /* expected */ }
  const elapsed = Date.now() - t0;
  assert.equal(attempts, 3, 'attempts');
  assert.equal(delays.length, 2, 'backoff called N-1 times');
  assert.ok(elapsed >= 80 && elapsed <= 500, `elapsed ${elapsed}ms (two 50ms sleeps)`);
});

test('retry: default backoff when no custom fn', async () => {
  let attempts = 0;
  try {
    await retry(
      async () => { attempts++; throw new Error('y'); },
      { retries: 1, baseDelayMs: 10, maxDelayMs: 50 },
    );
  } catch { /* expected */ }
  assert.equal(attempts, 2);
});
