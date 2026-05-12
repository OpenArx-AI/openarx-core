import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EmbedRouter } from './router.js';
import type { ModelHandler, SupportedModel } from './handlers/types.js';

class MockCache {
  store = new Map<string, number[]>();
  hits = 0;
  misses = 0;

  async mget(model: string, dim: number, texts: string[]) {
    return texts.map((t) => {
      const key = `${model}:${dim}:${t}`;
      const v = this.store.get(key);
      if (v) this.hits++; else this.misses++;
      return v;
    });
  }
  async mset(model: string, dim: number, pairs: Array<{ text: string; vector: number[] }>) {
    for (const { text, vector } of pairs) {
      this.store.set(`${model}:${dim}:${text}`, vector);
    }
  }
  async ping() { return true; }
  snapshot() { return { hits: this.hits, misses: this.misses, errors: 0 }; }
  async close() { /* noop */ }
}

class MockHandler implements ModelHandler {
  calls: string[][] = [];
  shouldFail = false;
  provider = 'mock';
  constructor(
    readonly model: SupportedModel,
    readonly dimensions: number,
  ) {}
  async embedUncached(texts: string[]) {
    if (this.shouldFail) throw new Error('forced failure');
    this.calls.push(texts);
    return {
      vectors: texts.map((t) => new Array(this.dimensions).fill(t.length)),
      provider: this.provider,
      inputTokens: texts.length * 10,
      cost: texts.length * 0.0001,
    };
  }
}

test('router: dispatches to handler and caches', async () => {
  const cache = new MockCache();
  const router = new EmbedRouter(cache as never);
  const handler = new MockHandler('specter2', 768);
  router.register(handler);

  const r1 = await router.embed({ texts: ['a', 'bb'], model: 'specter2' });
  assert.equal(r1.vectors.length, 2);
  assert.equal(r1.vectors[0].length, 768);
  assert.equal(r1.cached.filter((c) => c).length, 0);
  assert.equal(handler.calls.length, 1);
  assert.deepEqual(handler.calls[0], ['a', 'bb']);

  const r2 = await router.embed({ texts: ['a', 'ccc'], model: 'specter2' });
  assert.equal(r2.cached[0], true);
  assert.equal(r2.cached[1], false);
  assert.equal(handler.calls.length, 2);
  assert.deepEqual(handler.calls[1], ['ccc'], 'only uncached passed to handler');
  assert.equal(r2.vectors[0][0], 1, 'a has length 1 from cache');
  assert.equal(r2.vectors[1][0], 3, 'ccc has length 3 from handler');
});

test('router: unknown model rejected', async () => {
  const cache = new MockCache();
  const router = new EmbedRouter(cache as never);
  await assert.rejects(
    () => router.embed({ texts: ['a'], model: 'bogus' as SupportedModel }),
    /unsupported model/,
  );
});

test('router: handler error propagates, cache not polluted', async () => {
  const cache = new MockCache();
  const router = new EmbedRouter(cache as never);
  const handler = new MockHandler('specter2', 768);
  handler.shouldFail = true;
  router.register(handler);

  await assert.rejects(() => router.embed({ texts: ['x'], model: 'specter2' }), /forced failure/);
  assert.equal(cache.store.size, 0);
});

test('router: all-cached returns without calling handler', async () => {
  const cache = new MockCache();
  const router = new EmbedRouter(cache as never);
  const handler = new MockHandler('specter2', 768);
  router.register(handler);

  await router.embed({ texts: ['a'], model: 'specter2' });
  handler.calls.length = 0;

  const r = await router.embed({ texts: ['a', 'a', 'a'], model: 'specter2' });
  assert.equal(handler.calls.length, 0, 'handler should not be called');
  assert.deepEqual(r.cached, [true, true, true]);
  assert.equal(r.provider, 'cache');
});
