import { qwenPostprocess } from './handlers/qwen-postprocess.js';

/**
 * TeiPool — a load-balanced, RUNTIME-mutable pool of rented-GPU TEI backends serving
 * qwen3-embedding-8b (OpenAI-compatible /v1/embeddings). Modeled on the design of the former
 * @openarx/api EmbeddingPool — health-check + least-in-flight + per-backend capacity + graceful
 * degradation (that class served the retired self-hosted SPECTER2 fleet and was deleted with it in
 * Stage-2 Phase-3; the pattern is reproduced here, so nothing depends on it) — with three additions
 * the bulk re-embed fleet needs:
 *   1. RUNTIME add/remove — GPUs come and go during a multi-day run (admin endpoint), whereas the
 *      original pool was fixed at construction.
 *   2. TEI request/response shape + the canonical qwen recipe (qwenPostprocess, §1) so a
 *      TEI-served vector is interchangeable with the OpenRouter one.
 *   3. TEI-specific limits: client batch ≤32 (else HTTP 422); 429 → backpressure+retry
 *      on another backend, NOT an unhealthy mark.
 *
 * Fast failover (eject a dead/overloaded backend, keep serving on the rest) is automatic
 * here and in the caller's retry — it does NOT depend on the operator reacting in real
 * time (design: docs/qwen_embed_router_design.md).
 */

const HEALTH_INTERVAL_MS = Number(process.env.TEI_POOL_HEALTH_INTERVAL ?? 15_000);
const REQUEST_TIMEOUT_MS = Number(process.env.TEI_POOL_TIMEOUT ?? 120_000);
const MAX_RETRIES = Number(process.env.TEI_POOL_MAX_RETRIES ?? 3);
const CAPACITY_WAIT_MS = Number(process.env.TEI_POOL_CAPACITY_WAIT ?? 60_000);
const DEFAULT_MAX_CONCURRENCY = Number(process.env.TEI_POOL_MAX_CONCURRENCY ?? 8);
const HEALTH_TIMEOUT_MS = 5_000;
/** TEI --max-client-batch-size default; larger batches return HTTP 422. */
export const TEI_MAX_BATCH = 32;
/** Ask TEI to return this many dims instead of the native 4096 (Qwen3 is Matryoshka/MRL,
 *  so dims=768 = the first 768 dims = exactly what the client would truncate to). This is
 *  the egress mitigation: 4096 floats = 16.4KB/embedding over the tunnel vs 3KB at 768 (6×
 *  less bandwidth). Set TEI_REQUEST_DIMS=0 to fall back to native 4096 + client truncation
 *  (e.g. if a box's TEI ignores the param or server-side 768 ever fails re-verification).
 *  qwenPostprocess is robust to either — it truncates-if-longer then L2, so the recipe is
 *  identical whichever dims TEI returns (contracts §1; gate on the provider's 0.99997 test). */
const TEI_REQUEST_DIMS = Number(process.env.TEI_REQUEST_DIMS ?? 768);
/** Exact HF model id TEI expects — a lowercase alias makes TEI WARN "model not found"
 *  (it still embeds, but send the exact name). Only labels the request; the served model
 *  is fixed at TEI boot. */
const QWEN_MODEL = 'Qwen/Qwen3-Embedding-8B';

export interface TeiBackendSpec {
  /** Base URL (`http://host:port`) or full `.../v1/embeddings` URL — usually an S1 tunnel. */
  url: string;
  /** Optional bearer token (TEI has none by default; the SSH tunnel is the security). */
  apiKey?: string;
  /** Max concurrent in-flight requests to this backend (default 8 ≈ one 3090 saturated). */
  maxConcurrency?: number;
}

interface Backend {
  id: string;
  url: string;
  embeddingsUrl: string;
  healthUrl: string;
  apiKey?: string;
  maxConcurrency: number;
  healthy: boolean;
  inFlight: number;
  totalRequests: number;
  totalErrors: number;
  latencySum: number;
  consecutiveFailures: number;
  downSince: number | null;
  addedAt: number;
}

export interface TeiBackendHealth {
  id: string;
  url: string;
  healthy: boolean;
  inFlight: number;
  maxConcurrency: number;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface TeiPoolHealth {
  total: number;
  healthy: number;
  backends: TeiBackendHealth[];
}

/** Resolve a base/`/v1/embeddings` URL into the concrete POST + health endpoints. */
export function resolveTeiUrls(url: string): { embeddingsUrl: string; healthUrl: string } {
  const base = url.replace(/\/+$/, '').replace(/\/v1\/embeddings$/, '');
  return { embeddingsUrl: `${base}/v1/embeddings`, healthUrl: `${base}/health` };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TeiPool {
  private readonly backends = new Map<string, Backend>();
  private nextId = 1;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(seed: TeiBackendSpec[] = []) {
    for (const s of seed) this.addBackend(s);
    // Always run the health loop (even with 0 backends) so runtime-added ones are probed.
    this.healthTimer = setInterval(() => {
      void this.runHealthChecks();
    }, HEALTH_INTERVAL_MS);
  }

  /** Register a backend at runtime. Returns its generated id. Idempotent by URL: an
   *  existing backend with the same resolved endpoint is returned instead of duplicated. */
  addBackend(spec: TeiBackendSpec): string {
    const { embeddingsUrl, healthUrl } = resolveTeiUrls(spec.url);
    for (const b of this.backends.values()) {
      if (b.embeddingsUrl === embeddingsUrl) return b.id;
    }
    const id = `tei-${this.nextId++}`;
    this.backends.set(id, {
      id,
      url: spec.url,
      embeddingsUrl,
      healthUrl,
      apiKey: spec.apiKey,
      maxConcurrency: Math.max(1, spec.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
      healthy: true, // optimistic until first probe; a bad one ejects within one interval
      inFlight: 0,
      totalRequests: 0,
      totalErrors: 0,
      latencySum: 0,
      consecutiveFailures: 0,
      downSince: null,
      addedAt: Date.now(),
    });
    return id;
  }

  /** Deregister a backend by id. Returns true if it existed. In-flight requests already
   *  issued to it finish or fail on their own; no new work is routed to it. */
  removeBackend(id: string): boolean {
    return this.backends.delete(id);
  }

  hasHealthy(): boolean {
    for (const b of this.backends.values()) if (b.healthy) return true;
    return false;
  }

  size(): number {
    return this.backends.size;
  }

  getPoolHealth(): TeiPoolHealth {
    const backends: TeiBackendHealth[] = [...this.backends.values()].map((b) => ({
      id: b.id,
      url: b.url,
      healthy: b.healthy,
      inFlight: b.inFlight,
      maxConcurrency: b.maxConcurrency,
      requests: b.totalRequests,
      errors: b.totalErrors,
      avgLatencyMs: b.totalRequests > 0 ? Math.round(b.latencySum / b.totalRequests) : 0,
    }));
    return { total: backends.length, healthy: backends.filter((b) => b.healthy).length, backends };
  }

  destroy(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Embed texts across the pool. Splits into ≤32-text sub-batches and fans them out
   *  concurrently over healthy backends (least-in-flight), preserving input order. Every
   *  vector goes through qwenPostprocess so the output is interchangeable with OpenRouter. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = new Array(texts.length);
    const subs: Array<{ start: number; texts: string[] }> = [];
    for (let i = 0; i < texts.length; i += TEI_MAX_BATCH) {
      subs.push({ start: i, texts: texts.slice(i, i + TEI_MAX_BATCH) });
    }
    await Promise.all(
      subs.map(async (sb) => {
        const vecs = await this.embedSubBatch(sb.texts);
        for (let k = 0; k < vecs.length; k++) out[sb.start + k] = vecs[k];
      }),
    );
    return out;
  }

  // ─── private ───

  private async embedSubBatch(texts: string[]): Promise<number[][]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let backend = this.selectBackend();
      if (!backend) {
        const ok = await this.waitForCapacity(CAPACITY_WAIT_MS);
        backend = ok ? this.selectBackend() : null;
        if (!backend) throw new Error(`tei-pool: no healthy backend with capacity (waited ${CAPACITY_WAIT_MS / 1000}s)`);
      }
      backend.inFlight++;
      const start = performance.now();
      try {
        const vecs = await this.callBackend(backend, texts);
        backend.inFlight--;
        backend.totalRequests++;
        backend.latencySum += performance.now() - start;
        backend.consecutiveFailures = 0;
        backend.healthy = true;
        backend.downSince = null;
        return vecs;
      } catch (err) {
        backend.inFlight--;
        backend.totalErrors++;
        lastErr = err;
        const is429 = err instanceof Error && err.message.includes(' 429');
        if (is429) {
          // Backpressure, not a fault: give the backend a moment, retry (same or other).
          await sleep(200 * (attempt + 1));
        } else {
          backend.consecutiveFailures++;
          if (backend.consecutiveFailures >= 2) {
            backend.healthy = false;
            backend.downSince = backend.downSince ?? Date.now();
          }
        }
        if (attempt === MAX_RETRIES) break;
      }
    }
    throw new Error(`tei-pool: all ${MAX_RETRIES + 1} attempts failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  private async callBackend(backend: Backend, texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (backend.apiKey) headers.Authorization = `Bearer ${backend.apiKey}`;
      const body: Record<string, unknown> = { model: QWEN_MODEL, input: texts };
      if (TEI_REQUEST_DIMS > 0) body.dimensions = TEI_REQUEST_DIMS; // egress mitigation (see const)
      const resp = await fetch(backend.embeddingsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`tei ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = (await resp.json()) as { data?: Array<{ embedding: number[] }> };
      if (!Array.isArray(data.data) || data.data.length !== texts.length) {
        throw new Error(`tei returned ${Array.isArray(data.data) ? data.data.length : 'non-array'} for ${texts.length} texts`);
      }
      return data.data.map((d) => qwenPostprocess(d.embedding));
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Least-in-flight healthy backend with spare capacity; null if none available. */
  private selectBackend(): Backend | null {
    let best: Backend | null = null;
    for (const b of this.backends.values()) {
      if (b.healthy && b.inFlight < b.maxConcurrency && (best === null || b.inFlight < best.inFlight)) {
        best = b;
      }
    }
    return best;
  }

  private async waitForCapacity(timeoutMs: number): Promise<boolean> {
    // Just poll for a free slot — do NOT run health-checks here. With many sub-batches
    // waiting at once, per-waiter health probes fan out into a self-inflicted DoS on the
    // backends (this crashed the tunnels/TEI in the first 2-GPU canary). The periodic
    // 15s health loop is the single owner of health probing.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      if (this.selectBackend()) return true;
    }
    return false;
  }

  private async runHealthChecks(): Promise<void> {
    await Promise.all(
      [...this.backends.values()].map(async (b) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
          const resp = await fetch(b.healthUrl, { signal: controller.signal });
          clearTimeout(timeout);
          if (resp.ok) {
            b.healthy = true;
            b.consecutiveFailures = 0;
            b.downSince = null;
          } else {
            b.consecutiveFailures++;
            if (b.consecutiveFailures >= 2) {
              b.healthy = false;
              b.downSince = b.downSince ?? Date.now();
            }
          }
        } catch {
          b.consecutiveFailures++;
          if (b.consecutiveFailures >= 2) {
            b.healthy = false;
            b.downSince = b.downSince ?? Date.now();
          }
        }
      }),
    );
  }
}
