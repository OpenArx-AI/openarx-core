export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  /**
   * Custom backoff resolver. Receives the just-thrown error + the 0-indexed
   * attempt number that failed. Returns the delay in ms before the next try.
   * Return value is used instead of the default exponential schedule.
   */
  backoff?: (err: unknown, attempt: number) => number;
}

/** Longer backoff schedule for Google 429 (quota exhaustion). Default
 *  exponential schedule finishes in <10s, which is shorter than Vertex's
 *  per-minute quota refresh → all retries fail. 5 → 30 → 120s gives enough
 *  headroom to cross a minute boundary. */
export function vertexBackoff(err: unknown, attempt: number): number {
  const msg = err instanceof Error ? err.message : String(err);
  const is429 = msg.includes('(429)') || /\b429\b/.test(msg);
  if (!is429) {
    // Transient 5xx / network — standard exponential
    return Math.min(8_000, 500 * 2 ** attempt) * (0.5 + Math.random());
  }
  // 429 — longer waits so Vertex's per-minute quota can reopen
  const schedule = [5_000, 30_000, 120_000];
  const base = schedule[Math.min(attempt, schedule.length - 1)];
  return base * (0.8 + 0.4 * Math.random()); // jitter ±20%
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = opts.backoff
        ? opts.backoff(err, attempt)
        : Math.min(max, base * 2 ** attempt) * (0.5 + Math.random());
      console.error(
        `[retry${opts.label ? `:${opts.label}` : ''}] attempt ${attempt + 1}/${retries + 1} failed: ${(err as Error).message} — sleeping ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
