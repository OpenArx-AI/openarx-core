/** IPC command/response types for runner daemon ↔ CLI communication */

export type Direction = 'forward' | 'backfill' | 'mixed' | 'pending_only';

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
  limit: number;
  direction?: Direction;
  retry?: boolean;
  dateFrom?: string;
  dateTo?: string;
  strategy?: IngestStrategy;
  /** When true, runner workers pass {bypassCache: true} to every
   *  embed-service call. Useful for backfills where each chunk text
   *  is unique (cache hit-rate ≈ 0) and writing entries just evicts
   *  warmer search queries. Defaults to false. */
  bypassEmbedCache?: boolean;
  /** Per-run override of arxiv categories to PROCESS (post-fetch filter).
   *  Fetch happens unfiltered via OAI-PMH `set=cs`, returning all CS papers.
   *  Categories listed here decide which fetched papers actually get
   *  downloaded + indexed. Papers outside this list still bump
   *  `coverage_map.expected` per-cat (we know they exist on arxiv).
   *  When omitted, runner falls back to env RUNNER_CATEGORIES. */
  categories?: string[];
}

export interface StopCommand {
  type: 'stop';
}

export interface StatusCommand {
  type: 'status';
}

export interface CoverageCommand {
  type: 'coverage';
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
  | StopCommand
  | StatusCommand
  | CoverageCommand
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

export interface CoverageResult {
  source: string;
  forwardCursor: string | null;
  backfillCursor: string | null;
  totalPapers: number;
  runs: Array<{
    direction: string;
    dateFrom: string | null;
    dateTo: string | null;
    docsProcessed: number;
  }>;
}
