-- 026_document_reviews.sql
-- Pre-publish content quality review (openarx-contracts-4pd).
--
-- Sibling table to `documents`: one or more review versions per document,
-- recording the outcome of aspect 1 (spam screen) synchronously at publish
-- time and aspects 2-4 (structural quality, novelty+grounding, consolidated
-- report) asynchronously during the pipeline. Phase 1 only populates
-- aspect 1 columns — aspect 2-4 columns land NULL until Phase 2+.
--
-- Design ref: contracts/content_review.md §4 (APPROVED 2026-04-22).
-- Why a separate table rather than documents.content_review JSONB column:
--   - Re-runnable (versioning preserves methodology audit trail).
--   - Large JSON (similar_documents, suggestions) won't bloat hot
--     documents tuples used in search.
--   - Natural isolation for retention policies.
--
-- Ownership: Core-owned (S1 PG). Portal reads via /api/internal/content-review/:id.

CREATE TABLE IF NOT EXISTS document_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  -- Monotonic per-document version. Manual re-reviews (contract §5.1 trigger
  -- = 'manual') bump this; auto_on_publish returns the existing v=1 row.
  version INTEGER NOT NULL DEFAULT 1,

  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('auto_on_publish', 'manual')),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  -- Orchestration status, orthogonal to documents.status.
  -- 'pending' — row created, no aspect has run yet (transient).
  -- 'running' — aspect 1 done, aspects 2-3 still in-flight (Phase 2+).
  -- 'complete' — all enabled aspects finished (Phase 1: aspect 1 only).
  -- 'failed'   — aspect 1 hard-failed (fail-closed on infra outage).
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','complete','failed')),

  -- ── Aspect 1: spam / emptiness screening (synchronous) ──
  spam_verdict TEXT CHECK (spam_verdict IN ('pass','borderline','reject')),
  spam_reasons JSONB,   -- [{code: string, detail?: string}, ...]

  -- ── Aspect 2: structural quality + suggestions (Phase 3) ──
  quality_score NUMERIC(3,2),
  quality_suggestions JSONB,

  -- ── Aspect 3: novelty + grounding (Phase 2) ──
  novelty_score NUMERIC(3,2),
  grounding_score NUMERIC(3,2),
  similar_documents JSONB,

  -- ── Aspect 4: consolidated publisher-facing report (Phase 4) ──
  report_summary JSONB,

  -- ── Metadata ──

  -- USD spent on LLM calls for this specific review version. Summary only —
  -- authoritative per-call audit stays in processing_costs.
  llm_costs NUMERIC(6,4) DEFAULT 0,

  -- Publisher-chosen tier. Compute is always full (contract §1 invariant);
  -- this field gates what Portal returns to the publisher, not what Core
  -- computed. 'basic' readers see only spam_verdict + overall_verdict;
  -- 'full' readers see everything.
  report_tier TEXT NOT NULL DEFAULT 'full'
    CHECK (report_tier IN ('basic','full')),

  -- Public visibility on the document's public page. Inherits from prior
  -- version on new-version inserts (see trigger below). Contract §8 Variant D.
  public_visibility TEXT NOT NULL DEFAULT 'verdict_only'
    CHECK (public_visibility IN ('hidden','verdict_only','detailed')),

  UNIQUE (document_id, version)
);

-- Lookup by document (always wants latest version first).
CREATE INDEX IF NOT EXISTS idx_document_reviews_document
  ON document_reviews(document_id, version DESC);

-- Worker / poller scan for unfinished reviews. Partial index stays small
-- (only a handful of rows are in-flight at any moment).
CREATE INDEX IF NOT EXISTS idx_document_reviews_status
  ON document_reviews(status)
  WHERE status IN ('pending','running');

-- ── public_visibility inheritance trigger ──
-- When a new version is inserted for an existing document, copy
-- public_visibility from the prior-max-version row. Authors opt in/out
-- of public display persists across re-reviews without requiring
-- downstream to re-assert it on every UPDATE.
CREATE OR REPLACE FUNCTION inherit_public_visibility_from_prior()
RETURNS TRIGGER AS $$
DECLARE
  prior_visibility TEXT;
BEGIN
  -- Only inherit when caller didn't set an explicit non-default value.
  IF NEW.public_visibility IS NULL OR NEW.public_visibility = 'verdict_only' THEN
    SELECT public_visibility INTO prior_visibility
    FROM document_reviews
    WHERE document_id = NEW.document_id
      AND version < NEW.version
    ORDER BY version DESC
    LIMIT 1;
    IF prior_visibility IS NOT NULL THEN
      NEW.public_visibility := prior_visibility;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_document_reviews_inherit_visibility ON document_reviews;
CREATE TRIGGER trg_document_reviews_inherit_visibility
  BEFORE INSERT ON document_reviews
  FOR EACH ROW
  EXECUTE FUNCTION inherit_public_visibility_from_prior();
