// @openarx/api — Phase 0 backend
export { pool, query } from './db/pool.js';
export { computeOarxId, OARX_ID_RE, LEGACY_OARX_ID_RE, OARX_ID_HEX_LENGTH, LEGACY_OARX_ID_HEX_LENGTH } from './lib/oarx-id.js';
export { PgDocumentStore, APPLY_DOWNLOAD_SUCCESS_SQL } from './storage/document-store.js';
export { QdrantVectorStore } from './storage/vector-store.js';
export { SearchStore, type BM25Result } from './storage/search-store.js';
export { PgChunkStore, type ChunkStatusCounts } from './storage/chunk-store.js';
export { PgDocumentLocationStore } from './storage/document-location-store.js';
export { PgSourceRegistryStore } from './storage/source-registry-store.js';
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
  retry,
  type RetryOptions,
} from './model-router/index.js';

// ── Layer 2 — pillar storage. The PG record-graph (claims/relations/activities/metrics/
// bundles + the events outbox) was TORN DOWN (openarx-1woy): those stores are removed — Neo4j
// is the canonical graph and the methodist 2c path writes claim vectors directly to Qdrant.
// What remains below: the PURE schema-validation + same_as-dedup logic (kept for the Neo4j
// port, №4) and the Qdrant vector-store / claim projection (reused by the methodist path).
export {
  runIngressValidation,
  validateRecordSchema,
  validateRecordShape,
  existingRecordIds,
  type ValidateLevel,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationResult,
} from './storage/layer2-validate.js';
export {
  loadSameAsClusters,
  buildSameAsClusters,
  electCanonicalId,
  auditSameAsClusters,
  type SameAsClusters,
  type CanonicalElectRow,
  type SameAsAuditReport,
} from './storage/layer2-same-as.js';
export {
  handinHash,
  getOrCreateDossier,
  hasGo,
  findByHandinHash,
  recordCheckpoint,
  createEscalation,
  getEscalations,
  recordJournalExchange,
  type MethodistDossier,
  type CheckpointRecord,
  type EscalationRecord,
} from './storage/methodist-store.js';
export {
  buildClaimProjection,
  PAYLOAD_SCHEMA_VERSION,
  type ProjectionEdge,
  type ProjectionInput,
} from './storage/layer2-embed-projection.js';
export {
  Layer2VectorStore,
  LAYER2_COLLECTION,
  pointIdForClaim,
  projectionTextHash,
  type ClaimPointPayload,
  type ClaimSearchHit,
} from './storage/layer2-vector-store.js';

// ── wave-v2 methodist door-engine backends (F2.3) ────────────────────────────
export { neoGet, neoGetAny, neoPut, neoPutRelation, neoGraphCounts, neoDelete, getNeo4jDriver, closeNeo4j } from './db/neo4j.js';
export {
  getDossier,
  upsertDossier,
  type Dossier,
  type DossierPatch,
} from './storage/dossier-store.js';
export {
  appendRunJournal,
  listRunJournal,
  logRunToolCall,
  logMethodistToolCall,
  listRunToolLog,
  getMethodistIdempotency,
  recordMethodistIdempotency,
  recordMethodistLlmCost,
  type RunJournalEntry,
} from './storage/methodist-runtime-store.js';
