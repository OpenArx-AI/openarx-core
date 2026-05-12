/**
 * Enrichment loop — the single main loop of the enrichment worker.
 *
 * Cycle: selectNextBatch → enrichDocument for each (with concurrency) → repeat.
 * No upgrade loop (D9) — runner handles re-indexing via direction='pending_only'.
 *
 * Stops on: AbortSignal, AuthError (D11), or unrecoverable error.
 * Pauses on: DailyQuotaExhaustedError (sleeps until quota reset, then resumes).
 *
 * Design ref: docs/compliance/enrichment_worker_design.md
 */

import { selectNextBatch } from '../lib/selection.js';
import { enrichDocument } from '../lib/enrich-document.js';
import type { EnrichDeps, EnrichResult } from '../lib/enrich-document.js';
// DailyQuotaExhaustedError handled per-source inside enrichDocument
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('loop');

// ── Types ───────────────────────────────────────────────────

export interface EnrichmentLoopConfig {
  batchSize: number;
  concurrency: number;
  idleSleepMs: number;
}

export interface EnrichmentProgress {
  processed: number;
  enriched: number;
  noDoi: number;
  errors: number;
  filesDownloaded: number;
  reindexTriggered: number;
}

export const DEFAULT_LOOP_CONFIG: EnrichmentLoopConfig = {
  batchSize: 100,
  concurrency: 5,
  idleSleepMs: 5 * 60 * 1000, // 5 minutes
};

// ── Simple semaphore ────────────────────────────────────────

class Semaphore {
  private current = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.capacity) {
      this.current++;
      return;
    }
    return new Promise<void>(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.current--;
    }
  }
}

// ── Sleep with abort support ────────────────────────────────

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Main loop ───────────────────────────────────────────────

export async function runEnrichmentLoop(
  config: EnrichmentLoopConfig,
  enrichDeps: EnrichDeps,
  signal: AbortSignal,
  onProgress: (p: EnrichmentProgress) => void,
): Promise<void> {
  const progress: EnrichmentProgress = {
    processed: 0, enriched: 0, noDoi: 0,
    errors: 0, filesDownloaded: 0, reindexTriggered: 0,
  };

  while (!signal.aborted) {
    // Step 1: select batch
    const batch = await selectNextBatch(config.batchSize);

    if (batch.length === 0) {
      log.debug({ sleepMs: config.idleSleepMs }, 'idle — no documents to enrich');
      await sleepAbortable(config.idleSleepMs, signal);
      continue;
    }

    log.info({ count: batch.length, batchSize: config.batchSize }, 'batch_selected');

    // Step 2: process batch with concurrency
    const sem = new Semaphore(config.concurrency);
    const inFlight: Promise<void>[] = [];
    let authError: Error | null = null;

    for (const doc of batch) {
      if (signal.aborted || authError) break;

      await sem.acquire();

      const task = (async () => {
        try {
          const result = await enrichDocument(doc, enrichDeps);
          progress.processed++;

          if (result.status === 'enriched') {
            progress.enriched++;
            progress.filesDownloaded += result.filesDownloaded;
            if (result.reindexTriggered) progress.reindexTriggered++;
          } else if (result.status === 'no_doi') {
            progress.noDoi++;
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AuthError') {
            log.error({ source: (err as Error).message }, 'auth_error — stopping worker (D11)');
            authError = err;
            return;
          }
          // DailyQuotaExhaustedError is now handled per-source inside enrichDocument
          // (skips exhausted source, continues with others). Should not reach here,
          // but if it does — treat as non-fatal error, continue processing.
          log.error({ documentId: doc.documentId, error: err instanceof Error ? err.message : String(err) }, 'enrich_error');
          progress.errors++;
          progress.processed++;
        } finally {
          sem.release();
        }
      })();

      inFlight.push(task);
    }

    await Promise.allSettled(inFlight);

    // Report progress after each batch
    log.info({ ...progress }, 'batch_complete');
    onProgress({ ...progress });

    // D11: AuthError → stop entire worker
    if (authError) {
      throw authError;
    }

    // DailyQuotaExhausted no longer blocks the loop — handled per-source
    // inside enrichDocument (exhausted sources are skipped, others continue).
  }
}
