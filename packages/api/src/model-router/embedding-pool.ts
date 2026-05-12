/**
 * Embedding Pool — load-balanced SPECTER2 client across multiple servers.
 *
 * Strategy: per-server capacity (max N concurrent per server, round-robin selection).
 * Health checks every 30s. Retry on failure with next healthy server.
 * Graceful degradation: works with 1 of N servers alive.
 *
 * Servers use the texts API: POST /embed { texts: [string] }
 * Returns: { vectors: [[768 floats]], dimensions: 768, model: string }
 *
 * This client translates to/from the pipeline's text-based format:
 * Input: string[] (texts)  → Output: EmbedResponse { vectors, dimensions, model }
 */

import type { EmbedResponse } from '@openarx/types';

const HEALTH_INTERVAL = parseInt(process.env.EMBEDDING_POOL_HEALTH_INTERVAL ?? '30000', 10);
const REQUEST_TIMEOUT = parseInt(process.env.EMBEDDING_POOL_TIMEOUT ?? '120000', 10);
const MAX_RETRIES = parseInt(process.env.EMBEDDING_POOL_MAX_RETRIES ?? '2', 10);
const SERVER_WAIT_TIMEOUT = 60_000; // Max time to wait for a healthy server before failing
const MAX_PER_SERVER = parseInt(process.env.EMBEDDING_POOL_MAX_PER_SERVER ?? '1', 10);
const MAX_PAPERS_PER_REQUEST = 64;

interface ServerState {
  url: string;
  healthy: boolean;
  inFlight: number;
  totalRequests: number;
  totalErrors: number;
  latencySum: number;
  consecutiveFailures: number;
  downSince: Date | null;
}

interface Specter2Response {
  vectors: number[][];
  dimensions: number;
  model: string;
}

export class EmbeddingPool {
  private servers: Map<string, ServerState> = new Map();
  private serverList: ServerState[] = [];
  private roundRobinIdx = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(serverUrls: string[]) {
    for (const url of serverUrls) {
      this.servers.set(url, {
        url,
        healthy: true, // Assume healthy until first check
        inFlight: 0,
        totalRequests: 0,
        totalErrors: 0,
        latencySum: 0,
        consecutiveFailures: 0,
        downSince: null,
      });
    }

    this.serverList = [...this.servers.values()];

    // Start health checks
    if (serverUrls.length > 0) {
      this.runHealthChecks();
      this.healthTimer = setInterval(() => this.runHealthChecks(), HEALTH_INTERVAL);
      console.error(`[embedding-pool] ${serverUrls.length} servers, max ${MAX_PER_SERVER} concurrent per server`);
    }
  }

  /** Embed texts via pool. Translates text[] → papers API → EmbedResponse. */
  async embed(texts: string[]): Promise<EmbedResponse> {
    if (texts.length === 0) {
      return { vectors: [], dimensions: 768, model: 'allenai/specter2' };
    }

    // Split into batches of MAX_PAPERS_PER_REQUEST
    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_PAPERS_PER_REQUEST) {
      const batch = texts.slice(i, i + MAX_PAPERS_PER_REQUEST);
      const vectors = await this.embedBatch(batch);
      allVectors.push(...vectors);
    }

    return {
      vectors: allVectors,
      dimensions: 768,
      model: 'allenai/specter2',
    };
  }

  async health(): Promise<{ status: string; model: string }> {
    const healthy = this.getHealthyServers();
    if (healthy.length === 0) throw new Error('No healthy SPECTER2 servers');
    return { status: 'ok', model: 'allenai/specter2' };
  }

  getPoolHealth(): {
    activeServers: number;
    totalServers: number;
    servers: Array<{ url: string; healthy: boolean; inFlight: number; avgLatencyMs: number; requests: number; errors: number }>;
  } {
    const servers = [...this.servers.values()].map((s) => ({
      url: s.url,
      healthy: s.healthy,
      inFlight: s.inFlight,
      avgLatencyMs: s.totalRequests > 0 ? Math.round(s.latencySum / s.totalRequests) : 0,
      requests: s.totalRequests,
      errors: s.totalErrors,
    }));
    return {
      activeServers: servers.filter((s) => s.healthy).length,
      totalServers: servers.length,
      servers,
    };
  }

  destroy(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  // ─── Private ───

  private async embedBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const server = this.selectServer();
      if (!server) {
        // Wait for a server with available capacity (healthy + inFlight < MAX_PER_SERVER)
        const available = await this.waitForAvailableServer(SERVER_WAIT_TIMEOUT);
        if (!available) {
          throw new Error(`No available SPECTER2 servers (waited ${SERVER_WAIT_TIMEOUT / 1000}s, all at capacity or down)`);
        }
        const retryServer = this.selectServer();
        if (!retryServer) {
          throw new Error('No available SPECTER2 servers after wait');
        }
        return this.embedBatchOnServer(texts, retryServer);
      }

      try {
        server.inFlight++;
        const start = performance.now();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        const resp = await fetch(`${server.url}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`SPECTER2 ${resp.status}: ${body}`);
        }

        const data = (await resp.json()) as Specter2Response;
        const latency = performance.now() - start;

        server.totalRequests++;
        server.latencySum += latency;
        server.consecutiveFailures = 0;
        server.healthy = true;
        server.downSince = null;
        server.inFlight--;

        return data.vectors;
      } catch (err) {
        server.inFlight--;
        server.totalErrors++;
        server.consecutiveFailures++;

        if (server.consecutiveFailures >= 2) {
          if (server.healthy) {
            console.error(`[embedding-pool] Server overloaded: ${server.url} (${server.inFlight} in-flight)`);
          }
          server.healthy = false;
          server.downSince = server.downSince ?? new Date();
        }

        if (attempt === MAX_RETRIES) {
          throw new Error(`Embedding pool: all ${MAX_RETRIES + 1} attempts failed. Last: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Try next server
      }
    }

    throw new Error('Unreachable');
  }

  /** Wait for any server to become healthy AND have available capacity. */
  private async waitForAvailableServer(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));
      await this.runHealthChecks();
      if (this.selectServer()) return true;
    }
    return false;
  }

  /** Execute embed on a specific server (used after recovery wait). */
  private async embedBatchOnServer(texts: string[], server: ServerState): Promise<number[][]> {
    server.inFlight++;
    const start = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const resp = await fetch(`${server.url}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`SPECTER2 ${resp.status}: ${body}`);
      }
      const data = (await resp.json()) as Specter2Response;
      server.totalRequests++;
      server.latencySum += performance.now() - start;
      server.consecutiveFailures = 0;
      server.healthy = true;
      server.downSince = null;
      server.inFlight--;
      return data.vectors;
    } catch (err) {
      clearTimeout(timeout);
      server.inFlight--;
      server.totalErrors++;
      throw err;
    }
  }

  /** Round-robin: pick next healthy server with available capacity (inFlight < MAX_PER_SERVER). */
  private selectServer(): ServerState | null {
    const len = this.serverList.length;
    for (let i = 0; i < len; i++) {
      const idx = (this.roundRobinIdx + i) % len;
      const server = this.serverList[idx];
      if (server.healthy && server.inFlight < MAX_PER_SERVER) {
        this.roundRobinIdx = (idx + 1) % len;
        return server;
      }
    }
    return null; // all full or down
  }

  private getHealthyServers(): ServerState[] {
    return [...this.servers.values()].filter((s) => s.healthy);
  }

  private async runHealthChecks(): Promise<void> {
    for (const server of this.servers.values()) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${server.url}/health`, { signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          if (!server.healthy && server.downSince) {
            const downMs = Date.now() - server.downSince.getTime();
            if (downMs > 10_000) {
              console.error(`[embedding-pool] Server recovered: ${server.url} (was down ${Math.round(downMs / 1000)}s)`);
            }
          }
          server.healthy = true;
          server.consecutiveFailures = 0;
          server.downSince = null;
        } else {
          server.consecutiveFailures++;
          if (server.consecutiveFailures >= 2) {
            server.healthy = false;
            server.downSince = server.downSince ?? new Date();
          }
        }
      } catch {
        server.consecutiveFailures++;
        if (server.consecutiveFailures >= 2) {
          if (server.healthy) {
            console.error(`[embedding-pool] Server down: ${server.url}`);
          }
          server.healthy = false;
          server.downSince = server.downSince ?? new Date();
        }
      }
    }
  }
}
