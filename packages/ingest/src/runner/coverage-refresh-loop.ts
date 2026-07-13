/**
 * Coverage materialized-view refresh loop (Console fast aggregates).
 *
 * mv_coverage (migration 034) is a derived cache of `documents`. Postgres has
 * no native incremental matview refresh, so we run a FULL
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` — cheap (~5s) — on a cadence tied to
 * ingest activity:
 *   - every TICK_MS (~3 min) while a run is active (or within GRACE_MS after one,
 *     so the run's tail + completion are reflected),
 *   - plus an IDLE_MS (~30 min) fallback to catch out-of-band changes (manual
 *     edits, soft-delete/restore, doctor fixes).
 *
 * Drift is impossible — every refresh recomputes from documents. CONCURRENTLY
 * never blocks Console's reads. Non-blocking + non-critical: errors are logged,
 * never crash the runner.
 */
import { query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('coverage-refresh');

const TICK_MS = parseInt(process.env.COVERAGE_REFRESH_TICK_MS ?? '180000', 10); // 3 min
const GRACE_MS = parseInt(process.env.COVERAGE_REFRESH_GRACE_MS ?? '600000', 10); // keep refreshing 10 min after a run
const IDLE_MS = parseInt(process.env.COVERAGE_REFRESH_IDLE_MS ?? '1800000', 10); // idle fallback every 30 min

export class CoverageRefreshLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRefresh = 0;
  private lastRunActiveAt = 0;

  /** @param isRunning - reads the runner's live busy state (a run is in flight). */
  constructor(private readonly isRunning: () => boolean) {}

  start(): void {
    if (this.timer) return;
    log.info(
      { tickMs: TICK_MS, graceMs: GRACE_MS, idleMs: IDLE_MS },
      'coverage refresh loop start',
    );
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One refresh decision. Exposed for tests + manual trigger.
   *  Returns true if a refresh actually ran. */
  async tick(): Promise<boolean> {
    if (this.running) return false; // never overlap refreshes
    this.running = true;
    try {
      const now = Date.now();
      if (this.isRunning()) this.lastRunActiveAt = now;
      const activeOrGrace = now - this.lastRunActiveAt < GRACE_MS;
      const idleFallbackDue = now - this.lastRefresh >= IDLE_MS;
      if (!activeOrGrace && !idleFallbackDue) return false;

      await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_coverage');
      this.lastRefresh = Date.now();
      log.debug({ activeOrGrace, idleFallbackDue }, 'mv_coverage refreshed');
      return true;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'mv_coverage refresh failed (non-critical)',
      );
      return false;
    } finally {
      this.running = false;
    }
  }
}
