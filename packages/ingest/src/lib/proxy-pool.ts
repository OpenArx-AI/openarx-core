/**
 * Proxy Pool — round-robin rotation across HTTP proxies.
 *
 * Loads proxy list from file (PROXY_LIST_FILE env var).
 * Each call to getAgent() returns the next proxy's dispatcher.
 * Unhealthy proxies are skipped and rechecked periodically.
 */

import { readFileSync } from 'node:fs';
import { ProxyAgent } from 'undici';
import { createChildLogger } from './logger.js';

const log = createChildLogger('proxy-pool');

const HEALTH_RECHECK_MS = 5 * 60 * 1000; // Recheck unhealthy proxies every 5 min

interface ProxyState {
  url: string;
  healthy: boolean;
  downSince: Date | null;
}

let proxies: ProxyState[] = [];
let currentIndex = 0;
let initialized = false;

/** Load proxy list from file. Call once at startup. */
export function initProxyPool(): void {
  if (initialized) return;
  initialized = true;

  const filePath = process.env.PROXY_LIST_FILE;
  if (!filePath) {
    log.info('PROXY_LIST_FILE not set — direct connections (no proxy)');
    return;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    proxies = lines.map((line) => ({
      url: line.includes('://') ? line : `http://${line}`,
      healthy: true,
      downSince: null,
    }));
    log.info({ count: proxies.length, file: filePath }, 'Proxy pool loaded');
  } catch (err) {
    log.error({ err, file: filePath }, 'Failed to load proxy list');
  }
}

/** Get a ProxyAgent dispatcher for the next healthy proxy, or undefined for direct. */
export function getProxyDispatcher(): ProxyAgent | undefined {
  if (proxies.length === 0) return undefined;

  // Re-enable proxies that have been down long enough
  const now = Date.now();
  for (const p of proxies) {
    if (!p.healthy && p.downSince && now - p.downSince.getTime() > HEALTH_RECHECK_MS) {
      p.healthy = true;
      p.downSince = null;
    }
  }

  // Find next healthy proxy (round-robin)
  const startIdx = currentIndex;
  for (let i = 0; i < proxies.length; i++) {
    const idx = (startIdx + i) % proxies.length;
    const proxy = proxies[idx];
    if (proxy.healthy) {
      currentIndex = (idx + 1) % proxies.length;
      return new ProxyAgent(proxy.url);
    }
  }

  // All unhealthy — try first one anyway
  log.warn('All proxies unhealthy, using first');
  currentIndex = 1 % proxies.length;
  return new ProxyAgent(proxies[0].url);
}

/** Mark current proxy as unhealthy (call on connection error). */
export function markProxyUnhealthy(dispatcher: ProxyAgent | undefined): void {
  if (!dispatcher || proxies.length === 0) return;

  // Find which proxy this dispatcher belongs to by checking the URI
  // ProxyAgent doesn't expose its URL, so mark the previous one
  const prevIdx = (currentIndex - 1 + proxies.length) % proxies.length;
  const proxy = proxies[prevIdx];
  if (proxy.healthy) {
    proxy.healthy = false;
    proxy.downSince = new Date();
    log.warn({ proxy: proxy.url }, 'Proxy marked unhealthy');
  }
}

/** Get pool stats for monitoring. */
export function getProxyPoolStats(): { total: number; healthy: number; proxies: Array<{ url: string; healthy: boolean }> } {
  return {
    total: proxies.length,
    healthy: proxies.filter((p) => p.healthy).length,
    proxies: proxies.map((p) => ({ url: p.url, healthy: p.healthy })),
  };
}

/**
 * Fetch with proxy rotation. Drop-in replacement for global fetch.
 * Falls back to direct connection if no proxies configured.
 */
export async function fetchWithProxy(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  try {
    return await fetch(url, { ...init, dispatcher } as RequestInit);
  } catch (err) {
    markProxyUnhealthy(dispatcher);
    throw err;
  }
}
