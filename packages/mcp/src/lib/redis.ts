/**
 * Redis singleton — shared connection for rate limiting and ephemeral state.
 *
 * Graceful: if REDIS_URL not set or Redis unavailable, getRedis() returns null.
 * Consumers must handle null (fallback to in-memory).
 */

import { Redis } from 'ioredis';

let client: Redis | null = null;
let initAttempted = false;

export function getRedis(): Redis | null {
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      enableReadyCheck: true,
      retryStrategy(times: number) {
        if (times > 3) return null; // stop retrying after 3 attempts
        return Math.min(times * 500, 2000);
      },
    });

    client.on('error', (err: Error) => {
      console.error('[redis] Connection error:', err.message);
    });

    client.on('connect', () => {
      console.error('[redis] Connected');
    });

    return client;
  } catch {
    client = null;
    return null;
  }
}

export async function getRedisStatus(): Promise<'ok' | 'unavailable'> {
  const redis = getRedis();
  if (!redis) return 'unavailable';
  try {
    await redis.ping();
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
