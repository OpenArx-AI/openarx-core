// ── Parsed Document types (M0: parser validation) ──

export interface ParsedSection {
  name: string;
  content: string;
  level: number;
  subsections?: ParsedSection[];
}

export interface ParsedReference {
  raw: string;
  title?: string;
  authors?: string[];
  year?: number | string;
  doi?: string;
  venue?: string;
  url?: string;
}

export interface ParsedTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface ParsedFormula {
  raw: string;
  label?: string;
  context?: string;
}

export interface ParsedDocument {
  title: string;
  abstract: string;
  sections: ParsedSection[];
  references: ParsedReference[];
  tables: ParsedTable[];
  formulas: ParsedFormula[];
  parserUsed: string;
  parseDurationMs: number;
  /** Stats for parser-coverage diagnostics (optional). Populated by the
   *  LaTeX parser; undefined for other parsers. Do not rely on these in
   *  production code — they're for evaluation harnesses. */
  stats?: ParsedDocumentStats;
}

export interface ParsedDocumentStats {
  /** Files that `\input`/`\include`/`\import` referenced but we couldn't read. */
  missingIncludes: string[];
  /** Character count of the merged .tex after resolveInputs (before stripCommands). */
  mergedTexChars: number;
  /** Root .tex file selected by findRootTex (relative to sourceDir). */
  rootTex: string | null;
}

// ── arXiv metadata ──

export interface ArxivAuthor {
  name: string;
}

export interface ArxivPaperMetadata {
  arxivId: string;
  title: string;
  authors: ArxivAuthor[];
  abstract: string;
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  pdfUrl: string;
  sourceUrl?: string;
}

// ── Validation report types ──

export interface ParserResult {
  parser: string;
  success: boolean;
  error?: string;
  document?: ParsedDocument;
}

export interface PaperComparison {
  arxivId: string;
  title: string;
  pdfPath: string;
  hasLatexSource: boolean;
  results: ParserResult[];
  comparison: ComparisonMetrics;
}

export interface ComparisonMetrics {
  sectionCount: Record<string, number>;
  referenceCount: Record<string, number>;
  tableCount: Record<string, number>;
  formulaCount: Record<string, number>;
  titleMatch: Record<string, boolean>;
  abstractMatch: Record<string, boolean>;
  parseDurationMs: Record<string, number>;
}

export interface ValidationSummary {
  totalPapers: number;
  parsersCompared: string[];
  perParser: Record<
    string,
    {
      successCount: number;
      failCount: number;
      avgSections: number;
      avgReferences: number;
      avgTables: number;
      avgFormulas: number;
      avgDurationMs: number;
      titleMatchRate: number;
      abstractMatchRate: number;
    }
  >;
  recommendation: string;
}

export interface ValidationReport {
  generatedAt: string;
  papers: PaperComparison[];
  summary: ValidationSummary;
}

// ── M1: Document model (spec Section 3) ──

export interface Author {
  name: string;
  givenName?: string;
  familyName?: string;
  orcid?: string;
  email?: string;
  isCorresponding?: boolean;
  creditRoles?: string[];
}

export interface CodeLink {
  repoUrl: string;
  stars?: number;
  language?: string;
  extractedFrom: 'paper_text' | 'arxiv_metadata' | 'pwc_archive' | 'chunking_metadata' | 'author';
}

export interface DatasetLink {
  name: string;
  url?: string;
  extractedFrom: 'paper_text' | 'arxiv_metadata' | 'pwc_archive' | 'chunking_metadata' | 'author';
}

export interface BenchmarkResult {
  task: string;
  dataset: string;
  metric: string;
  score: number;
  extractedFrom: 'paper_text' | 'pwc_archive' | 'author';
}

export interface ProcessingLogEntry {
  step: string;
  status: 'started' | 'completed' | 'failed';
  timestamp: string;
  durationMs?: number;
  error?: string;
}

export interface ProvenanceEntry {
  op: string;
  at: string;
  commit: string;
  duration_ms?: number;
  pipeline_version?: string;
  model?: string;
  source_format?: string;
  chunks_total?: number;
  chunks_fixed?: number;
  re_embedded?: number;
  reason?: string;
}

export type DocumentStatus =
  | 'downloaded'
  | 'download_failed'
  | 'parsing'
  | 'chunking'
  | 'enriching'
  | 'embedding'
  | 'ready'
  | 'failed'
  | 'duplicate';

export interface Document {
  id: string;
  version: number;
  createdAt: Date;
  previousVersion?: string;
  conceptId?: string;

  // Source
  source: string;
  sourceId: string;
  sourceUrl: string;
  oarxId?: string;

  // Content (always English — translated if original was non-English)
  title: string;
  authors: Author[];
  abstract: string;
  // Original non-English text (null for English documents)
  originalTitle?: string;
  originalAbstract?: string;
  categories: string[];
  publishedAt: Date;
  rawContentPath: string;
  structuredContent: unknown;
  extractedMetadata?: {
    code_urls?: string[];
    dataset_mentions?: string[];
    benchmark_mentions?: string[];
  };

  // Sources: all available file formats for this document
  sources?: DocumentSources;
  // What parser was actually used: 'pdf' (GROBID/Mathpix) | 'latex'
  sourceFormat?: 'pdf' | 'latex' | 'markdown';

  // External identifiers (DOI, Semantic Scholar, DBLP, OpenAlex, etc.)
  externalIds: Record<string, string>;

  // Portal metadata (user-submitted documents)
  // Note: `license` is now the EFFECTIVE canonical SPDX, computed from `licenses`
  // multi-source map. For Portal docs the user-selected license becomes
  // licenses['manual']. For arXiv docs licenses['arxiv_oai'] is set at intake.
  license?: string;
  // Multi-source license map: { source_id: SPDX, ... }
  // e.g. { arxiv_oai: 'CC-BY-4.0', crossref: 'CC-BY-4.0', manual: 'CC0-1.0' }
  licenses?: Record<string, string>;
  // Pipeline indexing tier — determines which pipeline path was used
  // 'full'         — chunked + embedded normally
  // 'abstract_only' — only metadata + abstract embedding (lightweight, for restricted docs)
  // Note: license determination state is independent — documents lacking license
  // info are identified by `licenses === {}` (empty multi-source map), not by tier.
  indexingTier?: 'full' | 'abstract_only';
  keywords?: string[];
  language?: string;
  resourceType?: string;
  embargoUntil?: Date;
  portalMetadata?: Record<string, unknown>;

  // Linkage
  codeLinks: CodeLink[];
  datasetLinks: DatasetLink[];
  benchmarkResults: BenchmarkResult[];

  // Processing
  status: DocumentStatus;
  processingLog: ProcessingLogEntry[];
  processingCost: number;
  provenance: ProvenanceEntry[];
  retryCount: number;

  // Soft-delete (spec openarx-promo/docs/core_soft_delete_spec.md §4.1).
  // Single source of truth is `deletedAt` — document is active iff null.
  // Other fields are preserved after restore for audit (history interpretation).
  deletedAt?: Date | null;
  deletionReason?: DeletionReason | null;
  deletionMemo?: string | null;
  deletedBy?: string | null;
  deletionNoticeRef?: string | null;
  lastSeenAt?: Date | null;
}

/** Controlled vocabulary for deletion_reason (spec §4.1). */
export type DeletionReason =
  | 'dmca'           // DMCA / copyright takedown
  | 'tos_violation'  // Terms of Service breach
  | 'author_request' // Author-initiated removal (privacy / TDM opt-out)
  | 'quality'        // Content quality issue (corrupted, malformed, duplicate)
  | 'legal_other'    // Court order, regulator request, etc.
  | 'operator';      // Operator decision (catch-all)

/** document_audit_log entry. Append-only per convention (spec §4.2). */
export interface DocumentAuditEntry {
  id: number;
  documentId: string;
  action: 'delete' | 'restore' | 'ingest_skip' | 'memo_update';
  actor: string;
  reason: DeletionReason | null;
  memo: string | null;
  noticeRef: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface DocumentSources {
  pdf?: { path: string; size?: number };
  latex?: { path: string; rootTex?: string; manifest?: boolean; texFiles?: number };
  markdown?: { path: string };
}

// ── Chunk model ──

export interface ChunkContext {
  documentTitle: string;
  sectionName?: string;
  sectionPath?: string; // "Model Architecture > Attention > Scaled Dot-Product Attention"
  positionInDocument: number;
  totalChunks: number;
  summary?: string;
  keyConcept?: string;
  contentType?: string;    // 'theoretical' | 'methodology' | 'experimental' | 'results' | 'survey' | 'background' | 'other'
  entities?: string[];     // key named entities: method names, dataset names, metric names
  selfContained?: boolean; // true if chunk can be understood without surrounding context
}

export interface ChunkMetricValue {
  value: number | string | boolean;
  version: string;
  modelUsed?: string;
  computedAt: Date;
}

export interface Chunk {
  id: string;
  version: number;
  createdAt: Date;
  previousVersion?: string;

  documentId: string;

  content: string;
  context: ChunkContext;

  vectors: Record<string, number[]>;
  metrics: Record<string, ChunkMetricValue>;

  qdrantPointId?: string;

  // Lifecycle (openarx-q2eh — set on load from PgChunkStore)
  status?: 'pending_embed' | 'embedded' | 'indexed' | 'indexed_partial';
  embeddedAt?: Date;
  indexedAt?: Date;
}

// ── Storage interfaces ──

export interface DocumentStore {
  save(doc: Document): Promise<void>;
  getById(id: string): Promise<Document | null>;
  getBySourceId(source: string, sourceId: string): Promise<Document | null>;
  listByStatus(status: DocumentStatus, limit: number): Promise<Document[]>;
  updateStatus(
    id: string,
    status: DocumentStatus,
    log?: ProcessingLogEntry,
  ): Promise<void>;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  context: ChunkContext;
  score: number;
}

export interface HybridSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  context: ChunkContext;
  vectorScore: number;
  bm25Score: number;
  finalScore: number;
}

/** Qdrant-style filter shape. Exposes must + must_not for callers that
 *  need to exclude results (e.g. Aspect 3 novelty: exclude self-version
 *  chunks via must_not on concept_id). Each condition matches a single
 *  payload key to a literal value. */
export interface QdrantFilter {
  must?: Array<{ key: string; match: { value: string | number | boolean } }>;
  must_not?: Array<{ key: string; match: { value: string | number | boolean } }>;
}

/** One entry in a batched vector search. Each query carries its own
 *  vector, filter, and limit; all N queries hit Qdrant in a single
 *  /points/query/batch request. */
export interface BatchSearchQuery {
  vector: number[];
  vectorName: string;
  filter?: QdrantFilter;
  limit: number;
}

export interface VectorStore {
  upsertChunks(chunks: Chunk[], documentMeta?: { conceptId?: string; version?: number }): Promise<void>;
  search(
    query: number[],
    vectorName: string,
    limit: number,
    filters?: Record<string, unknown>,
    maxPerDocument?: number,
  ): Promise<SearchResult[]>;
  /** Run multiple searches in one HTTP roundtrip. Returns results in the
   *  same order as input queries. Empty input returns empty array. */
  batchSearch(queries: BatchSearchQuery[]): Promise<SearchResult[][]>;
  getByDocumentId(documentId: string): Promise<Chunk[]>;
  /** Create payload index on `deleted` (idempotent). Called at service
   *  startup so the soft-delete filter is cheap to apply. */
  initDeletedPayloadIndex(): Promise<void>;
  /** Flip `deleted` payload on all points belonging to documentId. Returns
   *  number of points updated. 0 means no points existed for the id. */
  setDocumentDeleted(documentId: string, deleted: boolean): Promise<number>;
}

// ── Model Router interfaces (spec Section 6) ──

export type ModelTask =
  | 'chunking'
  | 'enrichment'
  | 'quality_check'
  | 'search_rerank'
  | 'spam_screen'
  | 'translation';

export interface ModelOptions {
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface ModelResponse {
  text: string;
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  finishReason?: string; // 'STOP' | 'MAX_TOKENS' | 'SAFETY' | etc.
}

export interface ModelConfig {
  tasks: {
    [task in ModelTask]: {
      provider: string;
      model: string;
      fallback?: {
        provider: string;
        model: string;
      };
    };
  };
  apiKeys: Record<string, string>;
}

export interface EmbedResponse {
  vectors: number[][];
  dimensions: number;
  model: string;
  /** Which provider actually served the request — for cost tracking / observability */
  provider?: string;
  inputTokens?: number;
  cost?: number;
}

export interface ModelRouter {
  complete(
    task: ModelTask,
    prompt: string,
    options?: ModelOptions,
  ): Promise<ModelResponse>;
}

// ── Source adapter interfaces (spec Section 4) ──

export interface SourceAdapter {
  name: string;
  fetch(options: FetchOptions): AsyncGenerator<RawDocument>;
}

export interface FetchOptions {
  categories?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  mode: 'bulk' | 'incremental' | 'local';
}

export interface RawDocument {
  sourceId: string;
  title: string;
  authors: Author[];
  abstract: string;
  categories: string[];
  publishedAt: Date;
  pdfUrl: string;
  pdfPath: string;
  latexSourceUrl?: string;
  metadata: Record<string, unknown>;
}

// ── Pipeline interfaces (prep for M2) ──

export interface PipelineContext {
  documentId: string;
  modelRouter: ModelRouter;
  config: Record<string, unknown>;
  logger: {
    debug(msg: string, data?: unknown): void;
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
  };
  costTracker: {
    record(
      task: string,
      model: string,
      provider: string,
      inputTokens: number,
      outputTokens: number,
      cost: number,
      durationMs: number,
    ): Promise<void>;
  };
}

export interface PipelineStep<TIn, TOut> {
  name: string;
  process(input: TIn, context: PipelineContext): Promise<TOut>;
}
