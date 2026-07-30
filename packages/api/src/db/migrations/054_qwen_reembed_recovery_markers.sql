-- 054_qwen_reembed_recovery_markers.sql
-- Stage-1 corpus re-processing markers for the qwen embedding migration + verbatim
-- text recovery (epic openarx-lsqk; contract embedding_qwen_migration.md).
-- Additive, forward-only, NO backfill.
--
-- The Stage-1 background service is per-document, resumable, and decoupled (runs up
-- to ~2 weeks autonomously, blocking nothing). It needs:
--   1. a per-document resume marker  -> documents.qwen_reembed_at
--   2. a per-chunk recovery outcome  -> chunks.recovery_status (FAILED is never silent)

-- Per-document: set once a document's chunks are fully recovered + re-embedded into
-- the 768-slot (now qwen, physical named-vector still "specter2"). NULL = pending.
-- Resumability: on restart the service skips non-NULL docs and continues from where
-- it stopped (idempotent — no double-work, no double-charge).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS qwen_reembed_at timestamptz;

-- Find-next-pending-document query (format-ordered: latex before pdf), oldest first.
-- Partial index shrinks as docs are processed. Plain (non-CONCURRENT) index — documents
-- is ~2.3M rows and this migration runs before the long bulk; a brief lock is acceptable.
-- (CONCURRENTLY cannot run inside a migration transaction.)
CREATE INDEX IF NOT EXISTS idx_documents_qwen_reembed_pending
  ON documents (source_format, created_at)
  WHERE qwen_reembed_at IS NULL AND status = 'ready';

-- Per-chunk recovery outcome for the Stage-1 pass. NULL = not yet processed.
-- Values: 'recovered' | 'abbreviated' | 'failed' | 'skipped_no_source' | 'reembed_only'.
-- 'failed' and 'skipped_no_source' are explicit review signals — never a silent drop.
-- A nullable column add on chunks (~34.7M rows) is a metadata-only change in PostgreSQL
-- (no table rewrite, no default backfill).
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS recovery_status text;
