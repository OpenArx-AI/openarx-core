-- M3.23 — chunk-level lifecycle tracking (openarx-q2eh)
--
-- Persist chunks in PG immediately after chunker step so that transient
-- embed/index failures don't waste the LLM chunking cost. Chunks move through
-- states: pending_embed → embedded → indexed (or indexed_partial when SPECTER2
-- is missing). A doctor check recovers partial/orphan chunks.
--
-- Migration strategy for large chunks table (~1.2M rows):
-- - ADD COLUMN ... DEFAULT 'indexed' is O(1) in PG 11+ (attmissingval fast-default)
-- - CHECK constraint added as NOT VALID to skip the full-table scan;
--   new writes are validated, existing rows assumed-valid via fast-default
-- - embedded_at / indexed_at left NULL for pre-existing rows (observability
--   cost only — legacy chunks are long-since indexed)

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'indexed',
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;

-- NOT VALID: new INSERTs/UPDATEs are checked, existing rows assumed-valid.
-- They're all 'indexed' via the fast-default, which satisfies the constraint.
ALTER TABLE chunks
  DROP CONSTRAINT IF EXISTS chunks_status_check;
ALTER TABLE chunks
  ADD CONSTRAINT chunks_status_check
  CHECK (status IN ('pending_embed','embedded','indexed','indexed_partial'))
  NOT VALID;

-- Retry-path query: "chunks for doc X that still need work"
CREATE INDEX IF NOT EXISTS idx_chunks_status_doc
  ON chunks(document_id, status)
  WHERE status IN ('pending_embed','embedded','indexed_partial');

-- Orphan GC: "chunks stuck pending for more than N days"
CREATE INDEX IF NOT EXISTS idx_chunks_pending_created
  ON chunks(created_at)
  WHERE status IN ('pending_embed','embedded');
