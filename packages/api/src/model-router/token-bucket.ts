/**
 * Monotonic token bucket: guarantees a minimum interval between `acquire()`
 * returns, regardless of how many callers compete.
 *
 * Paces outbound Vertex AI calls below per-model RPM quota without bursting.
 * Used by VertexLlm for chunking + enrichment LLM calls (parallel docs in the
 * ingest pool used to hit Vertex simultaneously, triggering 429 cascades that
 * retries amplified; this serializes them through a single FIFO queue).
 *
 * Node.js event loop is single-threaded so the `nextAvailableAt` increment
 * is atomic — every caller claims a unique slot.
 *
 * In-process only. Separate processes (runner + enrichment-runner) each have
 * their own bucket and share the underlying Vertex quota independently.
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
