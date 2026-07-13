-- 036_chunks_pending_qdrant_index.sql
-- Partial index on chunks still pending Qdrant sync (qdrant_point_id IS NULL).
--
-- WHY: Console's dashboard/monitoring "Qdrant sync" widget counts pending-sync
-- chunks via `count(*) FROM chunks WHERE qdrant_point_id IS NULL`. Without an
-- index that is a sequential scan of the ~30M-row chunks table, which Console's
-- snapshot cron (*/2) ran ~every 40s — the dominant disk-read load on S1
-- (see bead openarx-1zuz; coordinated with msi:openarx-console, who switched
-- total_chunks to a pg_class.reltuples estimate in commit 6ac0bb9 so this
-- pending-count is the ONLY remaining scan to make cheap).
--
-- The partial index covers only the pending subset, so the count becomes an
-- index-only scan over a small set instead of a full table scan.
--
-- PROD APPLY NOTE: this file uses a plain (non-CONCURRENTLY) CREATE INDEX because
-- the migration runner wraps each file in BEGIN/COMMIT and CONCURRENTLY cannot run
-- inside a transaction. A plain build is fine for a fresh/empty DB via the runner.
-- On the LIVE 30M-row prod table the index MUST instead be built out-of-band with
-- CREATE INDEX CONCURRENTLY (no write-blocking lock during the active ingest wave):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chunks_pending_qdrant
--     ON chunks (id) WHERE qdrant_point_id IS NULL;
-- After that, this migration runs as a no-op (IF NOT EXISTS) and records schema_version.

CREATE INDEX IF NOT EXISTS idx_chunks_pending_qdrant
  ON chunks (id)
  WHERE qdrant_point_id IS NULL;
