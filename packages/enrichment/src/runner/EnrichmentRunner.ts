/**
 * EnrichmentRunner — manages the enrichment loop lifecycle.
 *
 * Creates dependencies, starts/stops the loop, tracks progress.
 * Intended to be controlled via Unix socket (socket-server.ts).
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D10)
 */

import { createChildLogger } from '../lib/logger.js';
import { createOpenAlexClient } from '../sources/openalex.js';
import { createUnpaywallClient } from '../sources/unpaywall.js';
import { createCoreClient } from '../sources/core.js';
import { createPmcClient } from '../sources/pmc.js';
import { createRateLimiter, DEFAULT_LIMITS } from '../lib/rate-limiter.js';
import { runEnrichmentLoop, DEFAULT_LOOP_CONFIG } from './enrichment-loop.js';
import type { EnrichmentLoopConfig, EnrichmentProgress } from './enrichment-loop.js';
import type { EnrichDeps } from '../lib/enrich-document.js';

const log = createChildLogger('runner');

export type RunnerState = 'idle' | 'running' | 'stopping' | 'error';

export interface RunnerStatus {
  state: RunnerState;
  uptime_sec: number;
  progress: EnrichmentProgress;
  lastError: string | null;
}

export class EnrichmentRunner {
  private state: RunnerState = 'idle';
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private startedAt: number = Date.now();
  private lastError: string | null = null;
  private progress: EnrichmentProgress = {
    processed: 0, enriched: 0, noDoi: 0,
    errors: 0, filesDownloaded: 0, reindexTriggered: 0,
  };

  private readonly config: EnrichmentLoopConfig;
  private readonly enrichDeps: EnrichDeps;

  constructor(opts?: { config?: Partial<EnrichmentLoopConfig>; dataDir?: string; statePath?: string }) {
    this.config = { ...DEFAULT_LOOP_CONFIG, ...opts?.config };

    const dataDir = opts?.dataDir ?? process.env.RUNNER_DATA_DIR ?? '/mnt/storagebox/arxiv';
    const email = process.env.ENRICHMENT_EMAIL ?? 'hello@openarx.ai';
    const coreApiKey = process.env.CORE_API_KEY;

    if (!coreApiKey) {
      throw new Error('CORE_API_KEY is required. Register at https://core.ac.uk/services/api');
    }

    const rateLimiter = createRateLimiter({
      sources: DEFAULT_LIMITS,
      statePath: opts?.statePath ?? process.env.ENRICHMENT_RATE_LIMIT_STATE ?? '/var/lib/openarx/enrichment-rate-limit.json',
    });

    this.enrichDeps = {
      openalex: createOpenAlexClient({ email }),
      unpaywall: createUnpaywallClient({ email }),
      core: createCoreClient({ apiKey: coreApiKey }),
      pmc: createPmcClient(),
      rateLimiter,
      dataDir,
    };
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;

    this.state = 'running';
    this.startedAt = Date.now();
    this.lastError = null;
    this.abortController = new AbortController();
    log.info({ config: this.config }, 'starting');

    this.loopPromise = runEnrichmentLoop(
      this.config,
      this.enrichDeps,
      this.abortController.signal,
      (p) => { this.progress = p; },
    ).catch((err) => {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      log.error({ error: this.lastError }, 'loop_error');
    }).then(() => {
      if (this.state === 'running') this.state = 'idle';
      log.info({ state: this.state, progress: this.progress }, 'loop_ended');
    });
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return;
    log.info('stopping');
    this.state = 'stopping';
    this.abortController?.abort();
    await this.loopPromise;
    this.state = 'idle';
    log.info({ progress: this.progress }, 'stopped');
  }

  status(): RunnerStatus {
    return {
      state: this.state,
      uptime_sec: Math.round((Date.now() - this.startedAt) / 1000),
      progress: { ...this.progress },
      lastError: this.lastError,
    };
  }

  stats(): EnrichmentProgress {
    return { ...this.progress };
  }
}
