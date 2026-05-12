import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TokenBucket } from './token-bucket.js';

test('TokenBucket: sequential acquires spaced by intervalMs', async () => {
  const bucket = new TokenBucket(6000); // 10ms interval
  const t0 = Date.now();
  await bucket.acquire();
  await bucket.acquire();
  await bucket.acquire();
  const elapsed = Date.now() - t0;
  // First is immediate, then 2 × 10ms waits → ~20ms
  assert.ok(elapsed >= 15 && elapsed <= 60, `elapsed=${elapsed}`);
});

test('TokenBucket: concurrent acquires each get unique slot', async () => {
  const bucket = new TokenBucket(6000); // 10ms interval
  const t0 = Date.now();
  const n = 10;
  await Promise.all(Array.from({ length: n }, () => bucket.acquire()));
  const elapsed = Date.now() - t0;
  // First is immediate, then 9 × 10ms → ~90ms
  assert.ok(elapsed >= 80 && elapsed <= 150, `${n} concurrent took ${elapsed}ms`);
});

test('TokenBucket: rate is respected over a sustained period', async () => {
  const rpm = 12000; // 5ms interval
  const bucket = new TokenBucket(rpm);
  const t0 = Date.now();
  const n = 30;
  for (let i = 0; i < n; i++) await bucket.acquire();
  const elapsed = Date.now() - t0;
  // 30 acquires, first immediate → (30-1)*5 = 145ms minimum
  assert.ok(elapsed >= 140, `30 tokens in ${elapsed}ms (min 140)`);
  // Actual rate
  const rate = (n / elapsed) * 60_000;
  assert.ok(rate <= rpm * 1.1, `rate ${rate} exceeds cap ${rpm}*1.1`);
});

test('TokenBucket: idle period does NOT refill (strictly monotonic, no burst)', async () => {
  const bucket = new TokenBucket(6000); // 10ms interval
  await bucket.acquire(); // slot t0+10
  // idle 100ms
  await new Promise((r) => setTimeout(r, 100));
  // Next acquire: bucket saw now > nextAvailableAt, so slot = now; next = now + 10
  // So this acquire is immediate but the one after waits 10ms
  const t1 = Date.now();
  await bucket.acquire();
  const ms1 = Date.now() - t1;
  assert.ok(ms1 < 5, `first post-idle acquire should be immediate, was ${ms1}ms`);
  const t2 = Date.now();
  await bucket.acquire();
  const ms2 = Date.now() - t2;
  assert.ok(ms2 >= 5 && ms2 <= 20, `second should wait intervalMs, was ${ms2}ms`);
});

test('TokenBucket: queueDepthMs grows with pending', async () => {
  const bucket = new TokenBucket(600); // 100ms interval
  void bucket.acquire();
  void bucket.acquire();
  void bucket.acquire();
  const depth = bucket.queueDepthMs();
  assert.ok(depth >= 200 && depth <= 310, `expected ~300ms queued, got ${depth}`);
});

test('TokenBucket: rejects invalid rate', () => {
  assert.throws(() => new TokenBucket(0));
  assert.throws(() => new TokenBucket(-10));
});
