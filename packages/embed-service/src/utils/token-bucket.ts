/**
 * Monotonic token bucket: guarantees a minimum interval between `acquire()`
 * returns, regardless of how many callers compete.
 *
 * Designed to pace outbound Vertex `:embedContent` calls below the
 * `online_prediction_requests_per_base_model` quota (4000 RPM for
 * gemini-embedding-2 in us-central1) without bursting.
 *
 * Node.js event loop is single-threaded so the `nextAvailableAt` increment
 * is atomic — every caller claims a unique slot.
 */
export class TokenBucket {
  private nextAvailableAt: number;
  private readonly intervalMs: number;

  constructor(ratePerMinute: number) {
    if (ratePerMinute <= 0) {
      throw new Error(`TokenBucket ratePerMinute must be > 0, got ${ratePerMinute}`);
    }
    this.intervalMs = 60_000 / ratePerMinute;
    this.nextAvailableAt = Date.now();
  }

  /** Wait until the bucket is ready to grant a token, then return. */
  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = slot + this.intervalMs;
    const waitFor = slot - now;
    if (waitFor > 0) await new Promise((r) => setTimeout(r, waitFor));
  }

  /** For diagnostics: current queue depth in ms (how far the next slot is
   *  from "now"). */
  queueDepthMs(): number {
    return Math.max(0, this.nextAvailableAt - Date.now());
  }
}
