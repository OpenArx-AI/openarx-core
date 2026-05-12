-- 025_qdrant_orphan_detection.sql
-- Track chunks whose qdrant_point_id is missing in the Qdrant `chunks`
-- collection. Populated by a pre-migration scan (scan-qdrant-orphans.ts)
-- so that migrate-embeddings can skip them and avoid poisoning sub-batches
-- with 404s that would otherwise fail 49 valid neighbours.
--
-- NULL  = not checked yet OR point exists in Qdrant
-- set   = timestamp of the scan that found the point missing in Qdrant.
--         These chunks are excluded from batch vectors-only upsert and
--         handled by a separate reindex-orphans pass later.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS qdrant_orphan_detected_at TIMESTAMPTZ;

-- Tiny partial index on the orphan subset (~500 rows expected) so that
-- any lookups over orphans are instant.
CREATE INDEX IF NOT EXISTS idx_chunks_qdrant_orphan
  ON chunks(id)
  WHERE qdrant_orphan_detected_at IS NOT NULL;
