-- 024_embedding_migration_state.sql
-- Track which chunks have been re-embedded by the openarx-8og1 migration
-- (gemini-embedding-001 → gemini-embedding-2-preview).
--
-- NULL  = not yet migrated
-- set   = timestamp when the new vector was successfully upserted to Qdrant
--
-- Partial index on NOT NULL IS NULL lets the migration script cheaply find
-- the next batch without scanning all 8.8M rows.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding_migrated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_migration_pending
  ON chunks(id)
  WHERE embedding_migrated_at IS NULL
    AND status IN ('indexed', 'indexed_partial');
