import { EmbeddingPool } from '@openarx/api';
import { retry } from '../utils/retry.js';
import type { ModelHandler } from './types.js';

const SPECTER2_DIM = 768;

interface Specter2Response {
  vectors: number[][];
  dimensions: number;
  model: string;
  inputTokens?: number;
}

export class Specter2Handler implements ModelHandler {
  readonly model = 'specter2' as const;
  readonly dimensions = SPECTER2_DIM;

  private readonly pool: EmbeddingPool | null;

  constructor(
    private readonly baseUrl: string,
    private readonly defaultBatchSize = 32,
    serverUrls: string[] = [],
  ) {
    // Pool mode when ≥2 servers; single host otherwise (a 1-server pool would
    // add health-check + capacity overhead without any load distribution).
    if (serverUrls.length >= 2) {
      this.pool = new EmbeddingPool(serverUrls);
    } else {
      this.pool = null;
    }
  }

  async embedUncached(texts: string[]): Promise<{
    vectors: number[][];
    provider: string;
    inputTokens: number;
    cost: number;
  }> {
    if (this.pool) {
      // EmbeddingPool handles retry, per-server capacity, and failover
      // internally — no outer retry wrapper needed.
      const data = await this.pool.embed(texts);
      return {
        vectors: data.vectors,
        provider: 'specter2-pool',
        inputTokens: 0,
        cost: 0,
      };
    }

    const data = await retry(
      () => this.callSpecter(texts),
      { label: 'specter2', retries: 3 },
    );
    return {
      vectors: data.vectors,
      provider: 'specter2-local',
      inputTokens: data.inputTokens ?? 0,
      cost: 0,
    };
  }

  private async callSpecter(texts: string[]): Promise<Specter2Response> {
    const resp = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, batch_size: this.defaultBatchSize }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`specter2 embed failed (${resp.status}): ${body.slice(0, 300)}`);
    }
    const data = (await resp.json()) as Specter2Response;
    if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) {
      throw new Error(`specter2 returned ${data.vectors?.length ?? 0} vectors for ${texts.length} texts`);
    }
    for (const v of data.vectors) {
      if (v.length !== SPECTER2_DIM) {
        throw new Error(`specter2 vector dim ${v.length} !== ${SPECTER2_DIM}`);
      }
    }
    return data;
  }
}
