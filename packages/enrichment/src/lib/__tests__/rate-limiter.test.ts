import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, DailyQuotaExhaustedError } from '../rate-limiter.js';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('per-second throttle', () => {
  test('acquire respects minInterval', async () => {
    const limiter = createRateLimiter({
      sources: { test: { maxPerSecond: 2, maxPerDay: 999_999 } },
    });

    const start = Date.now();
    await limiter.acquire('test');
    await limiter.acquire('test');
    await limiter.acquire('test');
    const elapsed = Date.now() - start;

    // 3 requests at 2/sec = need at least ~1000ms (2 intervals of 500ms)
    assert.ok(elapsed >= 900, `Expected >= 900ms, got ${elapsed}ms`);
  });

  test('fast source allows quick requests', async () => {
    const limiter = createRateLimiter({
      sources: { fast: { maxPerSecond: 100, maxPerDay: 999_999 } },
    });

    const start = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire('fast');
    const elapsed = Date.now() - start;

    // 100/sec = 10ms interval, 5 requests should be < 200ms
    assert.ok(elapsed < 200, `Expected < 200ms, got ${elapsed}ms`);
  });
});

describe('daily quota', () => {
  test('quota exhausted throws DailyQuotaExhaustedError', async () => {
    const limiter = createRateLimiter({
      sources: { tiny: { maxPerSecond: 1000, maxPerDay: 3 } },
    });

    await limiter.acquire('tiny');
    await limiter.acquire('tiny');
    await limiter.acquire('tiny');

    await assert.rejects(
      () => limiter.acquire('tiny'),
      (err: Error) => {
        assert.ok(err instanceof DailyQuotaExhaustedError);
        assert.equal((err as DailyQuotaExhaustedError).source, 'tiny');
        assert.equal((err as DailyQuotaExhaustedError).limit, 3);
        return true;
      },
    );
  });

  test('stats shows correct remaining', async () => {
    const limiter = createRateLimiter({
      sources: { s1: { maxPerSecond: 1000, maxPerDay: 100 } },
    });

    await limiter.acquire('s1');
    await limiter.acquire('s1');

    const s = limiter.stats();
    assert.equal(s.s1.consumedToday, 2);
    assert.equal(s.s1.remainingToday, 98);
    assert.ok(s.s1.resetAt.includes('T00:00:00'));
  });
});

describe('unknown source', () => {
  test('throws on unknown source', async () => {
    const limiter = createRateLimiter({
      sources: { known: { maxPerSecond: 1, maxPerDay: 100 } },
    });

    await assert.rejects(
      () => limiter.acquire('unknown'),
      (err: Error) => err.message.includes('Unknown rate limit source'),
    );
  });
});

describe('persistence', () => {
  const tmpDir = join(tmpdir(), 'openarx-rate-limiter-test-' + Date.now());
  const statePath = join(tmpDir, 'state.json');

  test('state persists and restores across instances', async () => {
    mkdirSync(tmpDir, { recursive: true });

    // Instance 1: consume some tokens
    const limiter1 = createRateLimiter({
      sources: { src: { maxPerSecond: 1000, maxPerDay: 1000 } },
      statePath,
    });

    // Consume 50 tokens (persistence triggers every 50)
    for (let i = 0; i < 50; i++) await limiter1.acquire('src');

    const stats1 = limiter1.stats();
    assert.equal(stats1.src.consumedToday, 50);

    // Verify file exists
    const raw = readFileSync(statePath, 'utf-8');
    const persisted = JSON.parse(raw);
    assert.equal(persisted.src.consumed, 50);

    // Instance 2: should restore counter
    const limiter2 = createRateLimiter({
      sources: { src: { maxPerSecond: 1000, maxPerDay: 1000 } },
      statePath,
    });

    const stats2 = limiter2.stats();
    assert.equal(stats2.src.consumedToday, 50);

    // Cleanup
    try { unlinkSync(statePath); unlinkSync(tmpDir); } catch { /* ok */ }
  });

  test('corrupt state file starts fresh', async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(statePath, 'NOT JSON!!!', 'utf-8');

    const limiter = createRateLimiter({
      sources: { src: { maxPerSecond: 1000, maxPerDay: 1000 } },
      statePath,
    });

    const stats = limiter.stats();
    assert.equal(stats.src.consumedToday, 0);

    try { unlinkSync(statePath); } catch { /* ok */ }
  });
});

describe('multiple sources', () => {
  test('sources are independent', async () => {
    const limiter = createRateLimiter({
      sources: {
        slow: { maxPerSecond: 1000, maxPerDay: 2 },
        fast: { maxPerSecond: 1000, maxPerDay: 100 },
      },
    });

    await limiter.acquire('slow');
    await limiter.acquire('slow');

    // slow exhausted
    await assert.rejects(() => limiter.acquire('slow'));

    // fast still works
    await limiter.acquire('fast');
    const s = limiter.stats();
    assert.equal(s.slow.remainingToday, 0);
    assert.equal(s.fast.remainingToday, 99);
  });
});
