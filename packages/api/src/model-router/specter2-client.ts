import type { EmbedResponse } from '@openarx/types';
import { retry } from './retry.js';
import { EmbeddingPool } from './embedding-pool.js';

const DEFAULT_URL = 'http://localhost:8090';

export interface Specter2ClientConfig {
  baseUrl?: string;
}

interface Specter2HealthResponse {
  status: string;
  model: string;
}

export class Specter2Client {
  private readonly baseUrl: string;
  private readonly pool: EmbeddingPool | null;

  constructor(config?: Specter2ClientConfig) {
    this.baseUrl = config?.baseUrl ?? process.env.SPECTER2_URL ?? DEFAULT_URL;

    // If EMBEDDING_SERVERS is set, use pool mode
    const servers = process.env.EMBEDDING_SERVERS;
    if (servers) {
      const urls = servers.split(',').map((s) => s.trim()).filter(Boolean);
      this.pool = new EmbeddingPool(urls);
      console.error(`[specter2-client] Pool mode: ${urls.length} servers`);
    } else {
      this.pool = null;
    }
  }

  async embed(texts: string[], batchSize?: number): Promise<EmbedResponse> {
    if (this.pool) {
      return this.pool.embed(texts);
    }
    // Legacy single-server mode
    return retry(() => this.callEmbed(texts, batchSize), 'specter2-embed');
  }

  async health(): Promise<Specter2HealthResponse> {
    if (this.pool) {
      return this.pool.health();
    }
    const resp = await fetch(`${this.baseUrl}/health`);
    if (!resp.ok) throw new Error(`SPECTER2 health check failed (${resp.status})`);
    return (await resp.json()) as Specter2HealthResponse;
  }

  /** Get pool stats (null if single-server mode). */
  getPoolHealth(): ReturnType<EmbeddingPool['getPoolHealth']> | null {
    return this.pool?.getPoolHealth() ?? null;
  }

  private async callEmbed(texts: string[], batchSize?: number): Promise<EmbedResponse> {
    const body: Record<string, unknown> = { texts };
    if (batchSize) body.batch_size = batchSize;

    const resp = await fetch(`${this.baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`SPECTER2 embed failed (${resp.status}): ${text}`);
    }

    return (await resp.json()) as EmbedResponse;
  }
}
