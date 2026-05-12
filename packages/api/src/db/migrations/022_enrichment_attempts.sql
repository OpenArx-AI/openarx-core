-- 021_enrichment_attempts.sql
-- Enrichment worker: cooldown tracking for alternative OA source discovery.
-- Part of epic openarx-54g3. Design: docs/compliance/enrichment_worker_design.md
--
-- ⚠️  DO NOT APPLY while doctor backfill (openarx-rfsj) is running.
--     Apply after doctor completes + openarx-r7g (source_registry, document_locations) is applied.

-- Global cooldown table (D4): one row per document per enrichment cycle.
-- Not per-source — all sources are queried atomically (D3).
CREATE TABLE IF NOT EXISTS enrichment_attempts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    attempted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sources_tried     TEXT[] NOT NULL DEFAULT '{}',
    oa_found_count    INT NOT NULL DEFAULT 0,
    status            VARCHAR(20) NOT NULL,  -- 'success_oa' | 'success_no_oa' | 'error'
    response_summary  JSONB,
    next_retry_at     TIMESTAMPTZ NOT NULL
);

-- Lookup by document (selection query cooldown check)
CREATE INDEX idx_enrichment_attempts_doc ON enrichment_attempts(document_id);

-- Find documents eligible for retry (next_retry_at < now())
CREATE INDEX idx_enrichment_attempts_retry ON enrichment_attempts(next_retry_at);

-- Schema version tracking handled by migrate.ts runner
