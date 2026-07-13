/** IPC command/response types for runner daemon ↔ CLI communication */

/**
 * Traversal order over the per-document registry (registry-driven ingest,
 * openarx-j173): 'forward' = ascending published_at (default), 'backward' =
 * descending.
 *
 * Legacy values accepted for socket compatibility and mapped on receipt:
 * 'backfill' → backward, 'mixed' → forward, 'pending_only' → downloaded-only
 * run (no dates + downloadedFirst).
 */
export type Direction = 'forward' | 'backward' | 'backfill' | 'mixed' | 'pending_only';

/**
 * Indexing strategy for an ingest run.
 *
 * - 'license_aware' (default): documents with open licenses get full pipeline
 *   indexing, restricted-license documents get abstract-only lightweight
 *   indexing.
 * - 'force_full': all documents go through full pipeline regardless of
 *   license. Useful for backfill, debug runs, or when budget allows.
 */
export type IngestStrategy = 'license_aware' | 'force_full';

export interface IngestCommand {
  type: 'ingest';
  /** Max documents taken into work this run. Always applies. Default 100. */
  limit: number;
  direction?: Direction;
  retry?: boolean;
  /** Period bounds over documents.published_at (inclusive). At least one of
   *  dateFrom/dateTo is required unless downloadedFirst-only run. */
  dateFrom?: string;
  dateTo?: string;
  /** Process ALL status='downloaded' docs first (no date filter, within
   *  limit), then continue with the period. Set alone (no dates) = process
   *  downloaded backlog only. Replaces the old implicit Step 0 + the
   *  pending_only direction. */
  downloadedFirst?: boolean;
  /** Re-index abstract_only documents that agents have REQUESTED (full-content
   *  demand SUM(get_document_count) > 1) to FULL. A separate stage AFTER the
   *  downloaded_first backlog, BEFORE new-doc indexing: each such doc is claimed
   *  one-at-a-time atomically (marked downloaded + forced indexing_tier='full') and
   *  fed into the parallel pipeline. Set alone (no dates) = process this backlog
   *  only. Default false. (indexing_tier is an economic PRIORITY signal, not a
   *  restriction — re-indexing deferred abstract_only docs to full is normal.) */
  reindexRequestedFirst?: boolean;
  strategy?: IngestStrategy;
  /** When true, runner workers pass {bypassCache: true} to every
   *  embed-service call. Useful for backfills where each chunk text
   *  is unique (cache hit-rate ≈ 0) and writing entries just evicts
   *  warmer search queries. Defaults to false. */
  bypassEmbedCache?: boolean;
  /** Registry selection filter: only documents whose categories overlap
   *  this list are taken (documents.categories && $cats). When omitted,
   *  runner falls back to env RUNNER_CATEGORIES; empty/unset = all. */
  categories?: string[];
}

/**
 * Fetch arXiv day listings into the per-document registry (status='listed'
 * rows). Same period/direction/limit logic as ingest; limit counts fetched
 * entries but a day is atomic — it is always finished, the limit is checked
 * at day boundaries. At least one date is required.
 */
export interface RegistryUpdateCommand {
  type: 'registry_update';
  dateFrom?: string;
  dateTo?: string;
  direction?: 'forward' | 'backward';
  limit?: number;
}

export interface StopCommand {
  type: 'stop';
}

export interface StatusCommand {
  type: 'status';
}

export interface HistoryCommand {
  type: 'history';
  limit: number;
}

export interface AuditCommand {
  type: 'audit';
  days?: number;
  date?: string; // YYYYMMDD
}

export interface DoctorCommand {
  type: 'doctor';
  fix?: boolean;
  check?: string;
  limit?: number;
}

export type RunnerCommand =
  | IngestCommand
  | RegistryUpdateCommand
  | StopCommand
  | StatusCommand
  | HistoryCommand
  | AuditCommand
  | DoctorCommand;

export interface RunnerResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface PipelineRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  direction: string;
  source: string;
  categories: string[];
  dateFrom: string | null;
  dateTo: string | null;
  docsFetched: number;
  docsProcessed: number;
  docsFailed: number;
  docsSkipped: number;
  totalCost: number | null;
  metrics: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
  lastProcessedId: string | null;
}

export interface StatusResult {
  state: 'idle' | 'running';
  currentRun?: {
    id: string;
    direction: string;
    docsProcessed: number;
    docsFailed: number;
    docsSkipped: number;
    startedAt: string;
    lastProcessedId: string | null;
  };
}

export interface AuditResult {
  daysChecked: number;
  daysComplete: number;
  daysWithGaps: number;
  totalMissing: number;
  totalDownloaded: number;
  details: Array<{
    day: string;
    arxivCount: number;
    dbCount: number;
    missing: number;
    downloaded: number;
  }>;
}
