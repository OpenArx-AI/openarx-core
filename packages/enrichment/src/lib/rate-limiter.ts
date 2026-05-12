/**
 * Per-source token bucket rate limiter with persistent daily counters.
 *
 * Two levels of protection:
 * 1. Per-second: minimum interval between requests (burst protection)
 * 2. Per-day: daily quota counter (API quota protection)
 *
 * Persistent state survives process restarts via JSON file.
 * Single-process only — no distributed locking.
 *
 * Design ref: docs/compliance/enrichment_worker_design.md
 */

import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { createChildLogger } from './logger.js';

const log = createChildLogger('rate-limiter');

export interface SourceLimits {
  maxPerSecond: number;
  maxPerDay: number;
}

export interface RateLimiterConfig {
  sources: Record<string, SourceLimits>;
  statePath?: string;
}

export interface RateLimiterStats {
  consumedToday: number;
  remainingToday: number;
  resetAt: string;
}

export interface RateLimiter {
  acquire(source: string): Promise<void>;
  stats(): Record<string, RateLimiterStats>;
}

export class DailyQuotaExhaustedError extends Error {
  constructor(public readonly source: string, public readonly limit: number) {
    super(`Daily quota exhausted for ${source} (limit: ${limit})`);
    this.name = 'DailyQuotaExhaustedError';
  }
}

interface SourceState {
  lastRequestMs: number;
  date: string;
  consumed: number;
}

interface PersistedState {
  [source: string]: { date: string; consumed: number };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowResetIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const DEFAULT_LIMITS: Record<string, SourceLimits> = {
  unpaywall: { maxPerSecond: 2, maxPerDay: 100_000 },
  openalex: { maxPerSecond: 5, maxPerDay: 100_000 },
  core: { maxPerSecond: 2, maxPerDay: 10_000 },
  pmc: { maxPerSecond: 3, maxPerDay: 999_999 },
};

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const limits = config.sources;
  const state: Record<string, SourceState> = {};

  // Initialize state for all configured sources
  for (const source of Object.keys(limits)) {
    state[source] = { lastRequestMs: 0, date: todayStr(), consumed: 0 };
  }

  // Load persisted state (sync on startup — called once)
  if (config.statePath) {
    try {
      const raw = readFileSync(config.statePath, 'utf-8');
      const persisted = JSON.parse(raw) as PersistedState;
      const today = todayStr();
      for (const [source, data] of Object.entries(persisted)) {
        if (state[source] && data.date === today) {
          state[source].consumed = data.consumed;
        }
      }
    } catch {
      // No state file or corrupt — start fresh
    }
  }

  async function persistState(): Promise<void> {
    if (!config.statePath) return;
    const data: PersistedState = {};
    for (const [source, s] of Object.entries(state)) {
      data[source] = { date: s.date, consumed: s.consumed };
    }
    const tmp = config.statePath + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmp, config.statePath);
  }

  async function acquire(source: string): Promise<void> {
    const lim = limits[source];
    if (!lim) throw new Error(`Unknown rate limit source: ${source}`);

    const s = state[source];
    const today = todayStr();

    // Daily reset if date changed
    if (s.date !== today) {
      s.date = today;
      s.consumed = 0;
    }

    // Check daily quota
    if (s.consumed >= lim.maxPerDay) {
      log.warn({ source, consumed: s.consumed, limit: lim.maxPerDay }, 'daily quota exhausted');
      throw new DailyQuotaExhaustedError(source, lim.maxPerDay);
    }

    // Per-second throttle: wait if too soon since last request
    const minIntervalMs = 1000 / lim.maxPerSecond;
    const elapsed = Date.now() - s.lastRequestMs;
    if (elapsed < minIntervalMs) {
      await new Promise(r => setTimeout(r, minIntervalMs - elapsed));
    }

    // Consume token
    s.lastRequestMs = Date.now();
    s.consumed++;

    // Persist every 50 requests (not every request — too expensive on disk)
    if (s.consumed % 50 === 0) {
      log.debug({ source, consumed: s.consumed, remaining: lim.maxPerDay - s.consumed }, 'state_persisted');
      await persistState();
    }
  }

  function stats(): Record<string, RateLimiterStats> {
    const today = todayStr();
    const resetAt = tomorrowResetIso();
    const result: Record<string, RateLimiterStats> = {};

    for (const [source, lim] of Object.entries(limits)) {
      const s = state[source];
      const consumed = s.date === today ? s.consumed : 0;
      result[source] = {
        consumedToday: consumed,
        remainingToday: lim.maxPerDay - consumed,
        resetAt,
      };
    }

    return result;
  }

  return { acquire, stats };
}
