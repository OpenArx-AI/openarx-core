import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenPostprocess, QWEN_DIM } from './handlers/qwen-postprocess.js';
import { TeiPool, resolveTeiUrls } from './tei-pool.js';

test('qwenPostprocess: L2-normalizes to unit length, keeps 768 dims', () => {
  const v = Array.from({ length: QWEN_DIM }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
  const out = qwenPostprocess(v);
  assert.equal(out.length, QWEN_DIM);
  const norm = Math.sqrt(out.reduce((a, x) => a + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm=${norm}`);
  // 3-4-5 triangle → normalized 0.6/0.8
  assert.ok(Math.abs(out[0] - 0.6) < 1e-9 && Math.abs(out[1] - 0.8) < 1e-9);
});

test('qwenPostprocess: truncates native 4096 to first 768 THEN normalizes', () => {
  const v = Array.from({ length: 4096 }, (_, i) => (i < QWEN_DIM ? 1 : 999));
  const out = qwenPostprocess(v);
  assert.equal(out.length, QWEN_DIM);
  // all first-768 equal → each = 1/sqrt(768); the 999s (dropped) never influence the norm
  const expected = 1 / Math.sqrt(QWEN_DIM);
  assert.ok(Math.abs(out[0] - expected) < 1e-12);
});

test('qwenPostprocess: rejects a vector shorter than 768 (never silently pads)', () => {
  assert.throws(() => qwenPostprocess([1, 2, 3]), /< 768/);
});

test('resolveTeiUrls: base URL and full /v1/embeddings URL both resolve consistently', () => {
  const a = resolveTeiUrls('http://localhost:8000');
  assert.equal(a.embeddingsUrl, 'http://localhost:8000/v1/embeddings');
  assert.equal(a.healthUrl, 'http://localhost:8000/health');
  const b = resolveTeiUrls('http://localhost:8000/v1/embeddings');
  assert.deepEqual(b, a);
  const c = resolveTeiUrls('http://localhost:8000/');
  assert.deepEqual(c, a);
});

test('TeiPool: runtime add/remove + idempotent-by-URL + health accounting', () => {
  const pool = new TeiPool();
  try {
    assert.equal(pool.size(), 0);
    assert.equal(pool.hasHealthy(), false);

    const id1 = pool.addBackend({ url: 'http://localhost:8000' });
    const id2 = pool.addBackend({ url: 'http://localhost:8001', maxConcurrency: 4 });
    assert.equal(pool.size(), 2);
    assert.equal(pool.hasHealthy(), true); // optimistic until first probe

    // same resolved endpoint → same backend, not a duplicate
    const id1dup = pool.addBackend({ url: 'http://localhost:8000/v1/embeddings' });
    assert.equal(id1dup, id1);
    assert.equal(pool.size(), 2);

    const health = pool.getPoolHealth();
    assert.equal(health.total, 2);
    assert.equal(health.healthy, 2);
    assert.equal(health.backends.find((b) => b.id === id2)?.maxConcurrency, 4);

    assert.equal(pool.removeBackend(id1), true);
    assert.equal(pool.removeBackend('tei-999'), false);
    assert.equal(pool.size(), 1);
  } finally {
    pool.destroy();
  }
});

test('TeiPool: embed([]) short-circuits without touching a backend', async () => {
  const pool = new TeiPool();
  try {
    assert.deepEqual(await pool.embed([]), []);
  } finally {
    pool.destroy();
  }
});
