// @openarx/api — Phase 0 backend
export { pool, query } from './db/pool.js';
export { PgDocumentStore } from './storage/document-store.js';
export { QdrantVectorStore } from './storage/vector-store.js';
export { SearchStore, type BM25Result } from './storage/search-store.js';
export { PgChunkStore, type ChunkStatusCounts } from './storage/chunk-store.js';
export {
  createInitialReview,
  triggerReview,
  getLatestReview,
  getReviewByVersion,
  getAllReviewVersions,
  patchLatestReviewTier,
  markReviewRunning,
  markReviewFailed,
  updateAspect3Fields,
  type DocumentReview,
} from './storage/review-store.js';
export {
  softDeleteDocument,
  restoreDocument,
  touchLastSeen,
  getDocumentForAdmin,
  listDeletedDocuments,
  AlreadyDeletedError,
  NotDeletedError,
  DocumentNotFoundError,
  type SoftDeleteInput,
  type SoftDeleteResult,
  type RestoreInput,
  type RestoreResult,
  type AdminDocSummary,
  type ListDeletedParams,
  type ListDeletedResult,
} from './storage/soft-delete-store.js';
export {
  appendAuditEntry,
  getAuditEntriesForDocument,
  type AuditAction,
  type AppendAuditInput,
} from './storage/audit-log-store.js';
export {
  // Re-export the review-store bits after the block closure above
  type ReviewStatus,
  type SpamVerdict,
  type TriggeredBy,
  type ReportTier,
  type PublicVisibility,
  type SpamReason,
  type CreateInitialReviewInput,
  type PatchTierResult,
} from './storage/review-store.js';
export {
  DefaultModelRouter,
  AnthropicLlm,
  OpenRouterLlm,
  VertexLlm,
  Specter2Client,
  EmbeddingPool,
  RerankerClient,
  EmbedClient,
  type EmbedClientConfig,
  type EmbedClientRequestOverrides,
  type EmbedModel,
  type EmbedderImpl,
  type RerankResponse,
} from './model-router/index.js';
