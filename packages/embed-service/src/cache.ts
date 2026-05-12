import { Redis } from 'ioredis';
import { cacheKey } from './utils/hash.js';
import { bufferToVector, vectorToBuffer } from './utils/float32.js';

export interface CacheMetricsSnapshot {
  hits: number;
  misses: number;
  errors: number;
}

export class EmbedCache {
  private readonly redis: Redis | null;
  private readonly ttl: number;
  private readonly disabled: boolean;
  private hits = 0;
  private misses = 0;
  private errors = 0;

  constructor(url: string, ttlSeconds: number, disabled = false) {
    this.ttl = ttlSeconds;
    this.disabled = disabled;
    if (disabled) {
      // No Redis connection at all — useful for secondary embed-service
      // instances deployed purely for migration scale-out (multi-server
      // experiment) where Redis infrastructure isn't available.
      this.redis = null;
      return;
    }
    this.redis = new Redis(url, {
      lazyConnect: false,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
    });
    this.redis.on('error', (err: Error) => {
      console.error(`[embed-cache] redis error: ${err.message}`);
      this.errors++;
    });
  }

  /** Lookup vectors for all texts. Returns array aligned with input; undefined = miss. */
  async mget(
    model: string,
    dim: number,
    texts: string[],
  ): Promise<Array<number[] | undefined>> {
    if (this.disabled || !this.redis || texts.length === 0) {
      return texts.map(() => undefined);
    }
    const keys = texts.map((t) => cacheKey(model, dim, t));
    try {
      const bufs = await this.redis.mgetBuffer(...keys);
      return bufs.map((buf: Buffer | null) => {
        if (!buf) {
          this.misses++;
          return undefined;
        }
        try {
          const v = bufferToVector(buf, dim);
          this.hits++;
          return v;
        } catch (err) {
          console.error(`[embed-cache] decode error: ${(err as Error).message}`);
          this.errors++;
          return undefined;
        }
      });
    } catch (err) {
      console.error(`[embed-cache] mget failed: ${(err as Error).message}`);
      this.errors++;
      return texts.map(() => undefined);
    }
  }

  /** Store vectors. Caller must ensure texts.length === vectors.length. */
  async mset(
    model: string,
    dim: number,
    pairs: Array<{ text: string; vector: number[] }>,
  ): Promise<void> {
    if (this.disabled || !this.redis || pairs.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const { text, vector } of pairs) {
        if (vector.length !== dim) {
          console.error(`[embed-cache] dim mismatch: got ${vector.length}, expected ${dim} — skipping write`);
          continue;
        }
        pipeline.set(cacheKey(model, dim, text), vectorToBuffer(vector), 'EX', this.ttl);
      }
      await pipeline.exec();
    } catch (err) {
      console.error(`[embed-cache] mset failed: ${(err as Error).message}`);
      this.errors++;
    }
  }

  /** Returns true if cache is disabled (report as always-healthy) or if
   *  the underlying Redis PINGs successfully. */
  async ping(): Promise<boolean> {
    if (this.disabled || !this.redis) return true;
    try {
      const r = await this.redis.ping();
      return r === 'PONG';
    } catch {
      return false;
    }
  }

  snapshot(): CacheMetricsSnapshot {
    return { hits: this.hits, misses: this.misses, errors: this.errors };
  }

  async close(): Promise<void> {
    if (this.redis) await this.redis.quit();
  }
}
