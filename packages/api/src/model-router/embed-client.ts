/**
 * EmbedClient — thin HTTP client to openarx-embed-service.
 *
 * The service is the only path to embeddings: ingest workers, doctor
 * checks, MCP query embedders all route through it (shared Redis cache
 * and rate-limiter). Consumers that want a fixed model wrap the client
 * via forModel() to get an EmbedderImpl-shaped object.
 *
 * Design notes:
 *   - Transport retry: 2 attempts on connection-level failures only
 *     (timeout, ECONNREFUSED, socket hangup). 5xx/4xx bubble straight up
 *     — the service has already exhausted its provider retries + fallback
 *     logic, retrying at the client would just double-waste.
 *   - cfg.bypassCache / cfg.allowFallback default to undefined so the
 *     service-side defaults (cache on, fallback on) apply.
 */

import type { EmbedResponse } from '@openarx/types';

export type EmbedModel =
  | 'specter2'
  | 'gemini-embedding-2-preview';

export interface EmbedClientConfig {
  url: string;
  secret: string;
  /** Transport-level timeout per request in ms. Default 60s. */
  timeoutMs?: number;
  /** Transport-level retries on connection errors. Default 2. */
  transportRetries?: number;
}

export interface EmbedClientRequestOverrides {
  taskType?: string;
  outputDimensionality?: number;
  allowFallback?: boolean;
  bypassCache?: boolean;
  /** Per-request override of transport timeout (ms). Default = client's
   *  configured timeoutMs. Useful for slow models (SPECTER2 under load). */
  timeoutMs?: number;
}

interface EmbedHttpResponse {
  vectors: number[][];
  model: string;
  dimensions: number;
  provider: string;
  cached: boolean[];
  inputTokens: number;
  cost: number;
}

/** Connection-level error classes that are safe to retry at the transport
 *  level (i.e., the request never reached the service). */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('eai_again')
  );
}

export class EmbedClient {
  private readonly url: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly transportRetries: number;

  constructor(cfg: EmbedClientConfig) {
    if (!cfg.url) throw new Error('EmbedClient: url is required');
    if (!cfg.secret) throw new Error('EmbedClient: secret is required');
    this.url = cfg.url.replace(/\/+$/, '');
    this.secret = cfg.secret;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    this.transportRetries = cfg.transportRetries ?? 2;
  }

  /** Send a single embed request. Retries only on connection-level errors. */
  async callEmbed(
    texts: string[],
    model: EmbedModel,
    overrides: EmbedClientRequestOverrides = {},
  ): Promise<EmbedResponse> {
    if (texts.length === 0) {
      return { vectors: [], model, dimensions: 0, provider: 'noop', inputTokens: 0, cost: 0 };
    }

    const body: Record<string, unknown> = { texts, model };
    if (overrides.taskType !== undefined) body.taskType = overrides.taskType;
    if (overrides.outputDimensionality !== undefined) body.outputDimensionality = overrides.outputDimensionality;
    if (overrides.allowFallback !== undefined) body.allowFallback = overrides.allowFallback;
    if (overrides.bypassCache !== undefined) body.bypassCache = overrides.bypassCache;

    const timeoutMs = overrides.timeoutMs ?? this.timeoutMs;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.transportRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(`${this.url}/embed`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Secret': this.secret,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) {
            // Service-side error (auth, bad request, provider failure after
            // internal retries). Do NOT retry at transport level.
            const text = await resp.text();
            throw new Error(
              `embed-service ${resp.status}: ${text.slice(0, 300)}`,
            );
          }
          const data = (await resp.json()) as EmbedHttpResponse;
          return {
            vectors: data.vectors,
            dimensions: data.dimensions,
            model: data.model,
            provider: data.provider,
            inputTokens: data.inputTokens,
            cost: data.cost,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
        if (!isConnectionError(err) || attempt === this.transportRetries) {
          throw err;
        }
        const delayMs = 200 * (attempt + 1);
        console.error(
          `[embed-client] connection error (attempt ${attempt + 1}/${this.transportRetries + 1}), retry in ${delayMs}ms: ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  /** Convenience: return an EmbedderImpl that always calls the given model. */
  forModel(
    model: EmbedModel,
    defaults: EmbedClientRequestOverrides = {},
  ): { embed(texts: string[]): Promise<EmbedResponse> } {
    return {
      embed: (texts) => this.callEmbed(texts, model, defaults),
    };
  }
}
