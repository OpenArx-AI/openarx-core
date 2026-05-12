import { retry } from './retry.js';

const DEFAULT_URL = 'http://localhost:8091';

// Multi-server round-robin: RERANKER_URLS=url1,url2,url3
const rerankerServers: string[] = (() => {
  const urls = process.env.RERANKER_URLS;
  if (urls) return urls.split(',').map((s) => s.trim()).filter(Boolean);
  const single = process.env.RERANKER_URL;
  if (single) return [single];
  return [DEFAULT_URL];
})();
let rerankerRoundRobin = 0;

if (rerankerServers.length > 1) {
  console.error(`[reranker-client] Pool mode: ${rerankerServers.length} servers`);
}

export interface RerankerClientConfig {
  baseUrl?: string;
}

export interface RerankResult {
  /** Original index in the input passages array */
  index: number;
  /** Relevance score (0-1, higher = more relevant) */
  score: number;
}

export interface RerankResponse {
  /** Results sorted by score descending */
  scores: RerankResult[];
  model: string;
}

interface RerankerHealthResponse {
  status: string;
  model: string;
}

export class RerankerClient {
  private readonly servers: string[];

  constructor(config?: RerankerClientConfig) {
    this.servers = config?.baseUrl ? [config.baseUrl] : rerankerServers;
  }

  private nextUrl(): string {
    const url = this.servers[rerankerRoundRobin % this.servers.length];
    rerankerRoundRobin++;
    return url;
  }

  /**
   * Rerank passages by relevance to query.
   * Returns results sorted by score descending.
   */
  async rerank(query: string, passages: string[], batchSize?: number): Promise<RerankResponse> {
    return retry(() => this.callRerank(query, passages, batchSize), 'reranker');
  }

  async health(): Promise<RerankerHealthResponse> {
    const resp = await fetch(`${this.nextUrl()}/health`);
    if (!resp.ok) throw new Error(`Reranker health check failed (${resp.status})`);
    return (await resp.json()) as RerankerHealthResponse;
  }

  private async callRerank(query: string, passages: string[], batchSize?: number): Promise<RerankResponse> {
    const body: Record<string, unknown> = { query, passages };
    if (batchSize) body.batch_size = batchSize;

    const resp = await fetch(`${this.nextUrl()}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Reranker failed (${resp.status}): ${text}`);
    }

    return (await resp.json()) as RerankResponse;
  }
}
