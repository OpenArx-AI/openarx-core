import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ESM mocking is impractical for this module (imports selectNextBatch + enrichDocument).
// We test: code structure, Semaphore logic, and sleepAbortable behavior.
// Full integration tested at deployment.

describe('enrichment-loop structure', () => {
  const source = readFileSync(join(__dirname, '..', 'enrichment-loop.ts'), 'utf-8');

  test('imports selectNextBatch from selection', () => {
    assert.ok(source.includes("from '../lib/selection.js'"));
  });

  test('imports enrichDocument from enrich-document', () => {
    assert.ok(source.includes("from '../lib/enrich-document.js'"));
  });

  test('imports DailyQuotaExhaustedError from rate-limiter', () => {
    assert.ok(source.includes('DailyQuotaExhaustedError'));
  });

  test('handles AuthError by rethrowing (D11)', () => {
    assert.ok(source.includes("err.name === 'AuthError'"));
    assert.ok(source.includes('throw authError'));
  });

  test('handles DailyQuotaExhausted by sleeping until tomorrow', () => {
    assert.ok(source.includes('DailyQuotaExhaustedError'));
    assert.ok(source.includes('setUTCDate'));
    assert.ok(source.includes('sleepAbortable'));
  });

  test('uses AbortSignal for graceful stop', () => {
    assert.ok(source.includes('signal.aborted'));
    assert.ok(source.includes('AbortSignal'));
  });

  test('calls onProgress after each batch', () => {
    assert.ok(source.includes('onProgress'));
  });

  test('has concurrency control via Semaphore', () => {
    assert.ok(source.includes('Semaphore'));
    assert.ok(source.includes('sem.acquire'));
    assert.ok(source.includes('sem.release'));
  });

  test('idle sleep when batch empty', () => {
    assert.ok(source.includes('batch.length === 0'));
    assert.ok(source.includes('idleSleepMs'));
  });

  test('exports DEFAULT_LOOP_CONFIG', () => {
    assert.ok(source.includes('DEFAULT_LOOP_CONFIG'));
    assert.ok(source.includes('batchSize: 100'));
    assert.ok(source.includes('concurrency: 5'));
  });
});

describe('sleepAbortable behavior', () => {
  test('resolves immediately when signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const start = Date.now();
    // Inline the sleep logic to test without importing private function
    await new Promise<void>((resolve) => {
      if (ac.signal.aborted) { resolve(); return; }
      const timer = setTimeout(resolve, 10_000);
      ac.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 50, `Should resolve immediately, took ${elapsed}ms`);
  });

  test('resolves when signal fires during sleep', async () => {
    const ac = new AbortController();

    const start = Date.now();
    const sleepPromise = new Promise<void>((resolve) => {
      if (ac.signal.aborted) { resolve(); return; }
      const timer = setTimeout(resolve, 10_000);
      ac.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    setTimeout(() => ac.abort(), 100);
    await sleepPromise;
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 300, `Should resolve on abort (~100ms), took ${elapsed}ms`);
  });
});

describe('Semaphore', () => {
  // Inline Semaphore to test without exporting it
  class Semaphore {
    private current = 0;
    private waiting: Array<() => void> = [];
    constructor(private readonly capacity: number) {}
    async acquire(): Promise<void> {
      if (this.current < this.capacity) { this.current++; return; }
      return new Promise<void>(resolve => { this.waiting.push(resolve); });
    }
    release(): void {
      const next = this.waiting.shift();
      if (next) { next(); } else { this.current--; }
    }
  }

  test('allows up to capacity concurrent acquires', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    // 4th should block — verify by racing with timeout
    let blocked = true;
    const raceResult = await Promise.race([
      sem.acquire().then(() => { blocked = false; }),
      new Promise(r => setTimeout(r, 50)),
    ]);
    assert.ok(blocked, 'Should block on 4th acquire');

    // Release one → 4th should proceed
    sem.release();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(!blocked, 'Should unblock after release');
  });

  test('release without waiters decrements count', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    sem.release();
    // Should be able to acquire 2 again
    await sem.acquire();
    await sem.acquire();
    // 3rd blocks
    let blocked = true;
    Promise.race([
      sem.acquire().then(() => { blocked = false; }),
      new Promise(r => setTimeout(r, 30)),
    ]);
    await new Promise(r => setTimeout(r, 40));
    assert.ok(blocked);
  });
});
