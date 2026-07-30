import { retry } from '../utils/retry.js';
import type { TeiPool } from '../tei-pool.js';
import { qwenPostprocess, QWEN_DIM } from './qwen-postprocess.js';
import type { EmbedHandlerOptions, ModelHandler } from './types.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/embeddings';
const OPENROUTER_MODEL = 'qwen/qwen3-embedding-8b';

export interface Qwen3HandlerConfig {
  openrouterApiKey: string;
  /** Optional pool of rented-GPU TEI backends. When it has ≥1 healthy backend, embed goes
   *  through it (the bulk path); otherwise falls back to OpenRouter (the operational path),
   *  unless the caller sets allowFallback=false. */
  teiPool?: TeiPool;
}

/**
 * qwen3-embedding-8b @768 — the 768-dim replacement for specter2 (contract identity `qwen`;
 * the physical Qdrant named-vector keeps the name `specter2`, mapped by the caller — see
 * embedding_qwen_migration §3). Two interchangeable backends behind one model:
 *   • rented-GPU TEI pool (bulk: cheaper + throughput-scaled) — used when healthy;
 *   • OpenRouter (operational/new-doc stream, and fallback) — otherwise.
 *
 * BOTH backends run the IDENTICAL vector recipe via qwenPostprocess (native→first-768→L2),
 * so a chunk yields the same vector whichever served it — contracts anchor §1/F1. Do NOT
 * change the recipe without re-validation (experimenter cross-cosine 0.99997).
 */
export class Qwen3Handler implements ModelHandler {
  readonly model = 'qwen3-embedding-8b' as const;
  readonly dimensions = QWEN_DIM;

  private readonly openrouterApiKey: string;
  private readonly teiPool?: TeiPool;

  constructor(cfg: Qwen3HandlerConfig) {
    this.openrouterApiKey = cfg.openrouterApiKey;
    this.teiPool = cfg.teiPool;
    if (!this.openrouterApiKey) {
      throw new Error('qwen3-embedding-8b: OpenRouter API key not configured (OPENROUTER_API_KEY)');
    }
  }

  async embedUncached(texts: string[], opts?: EmbedHandlerOptions): Promise<{
    vectors: number[][];
    provider: string;
    inputTokens: number;
    cost: number;
  }> {
    if (this.teiPool && this.teiPool.hasHealthy()) {
      const vectors = await this.teiPool.embed(texts);
      return { vectors, provider: 'qwen-tei-pool', inputTokens: 0, cost: 0 };
    }
    // Pool configured but no healthy backend AND caller forbids fallback (the bulk worker):
    // surface the error so it retries/pauses (resumable) instead of silently spending on
    // OpenRouter for 34.7M chunks (contracts: preserve allowFallback semantics).
    if (this.teiPool && opts?.allowFallback === false) {
      throw new Error('qwen: tei-pool has no healthy backend and allowFallback=false');
    }
    return retry(() => this.callOpenRouter(texts), { label: 'qwen-openrouter', retries: 3 });
  }

  private async callOpenRouter(texts: string[]): Promise<{
    vectors: number[][];
    provider: string;
    inputTokens: number;
    cost: number;
  }> {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openrouterApiKey}`,
        'Content-Type': 'application/json',
      },
      // provider.sort=price → cheapest provider serving qwen3-embedding-8b (default routing
      // measured ~5.6x target in the canary). Providers are interchangeable (0.99997).
      body: JSON.stringify({ model: OPENROUTER_MODEL, input: texts, dimensions: QWEN_DIM, provider: { sort: 'price' } }),
    });
    if (!resp.ok) {
      throw new Error(`OpenRouter ${OPENROUTER_MODEL} failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      data?: Array<{ embedding: number[] }>;
      usage?: { prompt_tokens?: number; cost?: number };
    };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error(
        `OpenRouter ${OPENROUTER_MODEL} returned wrong count (sent=${texts.length}, got=${Array.isArray(data.data) ? data.data.length : 'non-array'})`,
      );
    }
    // Same canonical recipe as the TEI path — first-768 + L2 (contracts §1). This adds the
    // L2 the earlier version omitted, so OpenRouter and TEI vectors are byte-for-byte the
    // same recipe (cosine-invariant, so already-written vectors are unaffected).
    const vectors = data.data.map((d) => qwenPostprocess(d.embedding));
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const cost = data.usage?.cost ?? 0;
    return { vectors, provider: 'qwen-openrouter', inputTokens, cost };
  }
}
