import { ServiceAccountAuth } from '../auth/service-account.js';
import { mapConcurrent } from '../utils/pool.js';
import { retry } from '../utils/retry.js';
import { TokenBucket } from '../utils/token-bucket.js';
import type { EmbedHandlerOptions, ModelHandler } from './types.js';

const MODEL = 'gemini-embedding-2-preview';
const DIMENSIONS = 3072;
const COST_PER_M_TOKENS = 0.15;
const OPENROUTER_MODEL = 'google/gemini-embedding-2-preview';

export interface Gemini2HandlerConfig {
  openrouterApiKey: string;
  serviceAccountKeyFile: string | undefined;
  googleCloudProject: string | undefined;
  googleCloudLocation: string;
  concurrencyLimit: number;
  /** Upper bound on Vertex `:embedContent` requests per minute.
   *  Monotonic spacing guarantees we never burst past this. Stay under
   *  Google's `online_prediction_requests_per_base_model` quota for
   *  gemini-embedding-2 (4000 RPM us-central1). Default 3800 leaves
   *  headroom for runner traffic + clock skew. 0 disables rate limiting. */
  vertexRatePerMinute: number;
}

interface EmbedContentResponse {
  embedding: { values: number[] };
}

/**
 * gemini-embedding-2-preview via Vertex :embedContent (per-call, no native batch).
 * Concurrency pool parallelises many single-text calls. OpenRouter fallback on
 * Vertex failure — can be disabled per-request via `allowFallback: false`
 * (migration script uses this to avoid silent spend on OpenRouter).
 *
 * Retry backoff is tuned per error type: 429 (Google quota) gets
 * 5s → 30s → 120s so retries span the per-minute quota refresh window;
 * everything else uses the standard exponential schedule.
 */
export class Gemini2Handler implements ModelHandler {
  readonly model = 'gemini-embedding-2-preview' as const;
  readonly dimensions = DIMENSIONS;

  private readonly sa: ServiceAccountAuth | null;
  private readonly vertexEndpoint: string | null;
  private readonly concurrency: number;
  private readonly openrouterApiKey: string;
  /** Null = unlimited. Otherwise guards every Vertex call (first attempt
   *  AND retries) so we stay below the project-level quota. */
  private readonly bucket: TokenBucket | null;

  constructor(cfg: Gemini2HandlerConfig) {
    this.concurrency = cfg.concurrencyLimit;
    this.bucket = cfg.vertexRatePerMinute > 0
      ? new TokenBucket(cfg.vertexRatePerMinute)
      : null;
    if (cfg.serviceAccountKeyFile && cfg.googleCloudProject) {
      this.sa = new ServiceAccountAuth(cfg.serviceAccountKeyFile);
      this.vertexEndpoint = `https://${cfg.googleCloudLocation}-aiplatform.googleapis.com/v1/projects/${cfg.googleCloudProject}/locations/${cfg.googleCloudLocation}/publishers/google/models/${MODEL}:embedContent`;
    } else {
      this.sa = null;
      this.vertexEndpoint = null;
    }
    this.openrouterApiKey = cfg.openrouterApiKey;
    if (!this.sa && !this.openrouterApiKey) {
      throw new Error('gemini-embedding-2-preview: neither Vertex SA nor OpenRouter configured');
    }
  }

  async embedUncached(texts: string[], opts: EmbedHandlerOptions = {}): Promise<{
    vectors: number[][];
    provider: string;
    inputTokens: number;
    cost: number;
  }> {
    const { taskType, allowFallback = true } = opts;

    if (this.sa && this.vertexEndpoint) {
      try {
        // Note: retry shares the same TokenBucket — a 429'd call re-queues
        // for its next monotonic slot, no extra exponential backoff.
        const vectors = await mapConcurrent(texts, this.concurrency, (text, i) =>
          retry(
            () => this.callVertex(text, taskType),
            {
              label: `gemini2-vertex-${i}`,
              retries: 3,
              baseDelayMs: 100,
              maxDelayMs: 500,
            },
          ),
        );
        const inputTokens = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
        return {
          vectors,
          provider: 'vertex',
          inputTokens,
          cost: (inputTokens * COST_PER_M_TOKENS) / 1_000_000,
        };
      } catch (err) {
        const msg = (err as Error).message;
        if (!allowFallback) {
          console.error(`[gemini-2-preview] vertex failed, fallback disabled: ${msg}`);
          throw err;
        }
        if (!this.openrouterApiKey) throw err;
        console.error(`[gemini-2-preview] vertex failed, falling back to openrouter: ${msg}`);
      }
    } else if (!allowFallback) {
      throw new Error('gemini-2-preview: Vertex SA not configured and fallback disabled');
    }
    return retry(() => this.callOpenRouter(texts), { label: 'gemini2-openrouter', retries: 3 });
  }

  private async callVertex(text: string, taskType?: string): Promise<number[]> {
    // Bucket acquired BEFORE the HTTP call so retries (which re-enter this
    // method via the retry wrapper) also wait for a token — keeping total
    // outbound rate strictly below the project quota.
    if (this.bucket) await this.bucket.acquire();
    const token = await this.sa!.getAccessToken();
    const body: Record<string, unknown> = {
      content: { parts: [{ text }] },
      outputDimensionality: DIMENSIONS,
    };
    if (taskType) body.taskType = taskType;
    const resp = await fetch(this.vertexEndpoint!, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Vertex embedContent failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    }
    const data = (await resp.json()) as EmbedContentResponse;
    const values = data?.embedding?.values;
    if (!values || values.length !== DIMENSIONS) {
      throw new Error(`Vertex malformed embedContent response (dim=${values?.length ?? 0})`);
    }
    return values;
  }

  private async callOpenRouter(texts: string[]): Promise<{
    vectors: number[][];
    provider: string;
    inputTokens: number;
    cost: number;
  }> {
    const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openrouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, input: texts }),
    });
    if (!resp.ok) {
      throw new Error(`OpenRouter ${OPENROUTER_MODEL} failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    }
    const data = await resp.json() as {
      data: Array<{ embedding: number[] }>;
      usage?: { prompt_tokens: number };
    };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      // Diagnostic: observed failure mode but unclear root cause (openarx debug).
      // Log everything that helps distinguish: batch-bug (got=1), silent filter
      // (got<N), response-shape weirdness (not an array), or dim mismatch.
      const sample = texts.map((t, i) => ({ idx: i, chars: t.length }));
      console.error(
        `[gemini-2-preview] OpenRouter count mismatch: sent=${texts.length} got=${Array.isArray(data.data) ? data.data.length : typeof data.data} ` +
        `respKeys=${Object.keys(data).join(',')} ` +
        `firstEmbedDim=${data.data?.[0]?.embedding?.length ?? 'n/a'} ` +
        `lastEmbedDim=${data.data?.[(data.data?.length ?? 1) - 1]?.embedding?.length ?? 'n/a'} ` +
        `inputSample=${JSON.stringify(sample)} ` +
        `rawResponse=${JSON.stringify(data).slice(0, 2000)}`,
      );
      throw new Error(
        `OpenRouter ${OPENROUTER_MODEL} returned wrong count (sent=${texts.length}, got=${Array.isArray(data.data) ? data.data.length : 'non-array'})`,
      );
    }
    const vectors = data.data.map((d) => d.embedding);
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    return {
      vectors,
      provider: 'openrouter',
      inputTokens,
      cost: (inputTokens * COST_PER_M_TOKENS) / 1_000_000,
    };
  }
}
