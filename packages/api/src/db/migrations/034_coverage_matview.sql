-- 034: mv_coverage — materialized view for fast Console coverage/category aggregates.
--
-- Replaces the per-request unnest(categories)+GROUP BY full scans (~5-6s) Console
-- ran over `documents`. This is a PURE DERIVED CACHE of documents (the truth
-- source), refreshed by the runner on a ~3-5min timer during ingest runs + on
-- completion (REFRESH MATERIALIZED VIEW CONCURRENTLY). Unlike the removed
-- coverage_map (a hand-maintained incremental counter that drifted), a full
-- recompute on every refresh makes drift impossible.
--
-- One row = (publication month, arXiv category, doc status, indexing tier, doc count).
-- indexing_tier is in the grain (Console openarx-console-760: month-level full vs
-- abstract_only split for the Coverage Map). COALESCE'd to 'none' for non-ready
-- statuses (tier is NULL there) so the unique index has no NULLs and REFRESH
-- CONCURRENTLY matches rows cleanly (a NULL in the key would churn those rows
-- every refresh). Consumers read tier only for status='ready' (full|abstract_only).
-- Serves both Console needs:
--   category dropdown: SELECT category, sum(n) FROM mv_coverage WHERE status='ready' GROUP BY 1 ORDER BY 2 DESC;
--   coverage map:      SELECT month, status, sum(n) FROM mv_coverage GROUP BY 1,2;  (+ optional WHERE category=...)
--   month tier split:  SELECT month, indexing_tier, sum(n) FROM mv_coverage WHERE status='ready' GROUP BY 1,2;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_coverage AS
SELECT date_trunc('month', published_at)::date AS month,
       cat AS category,
       status,
       COALESCE(indexing_tier, 'none') AS indexing_tier,
       count(*)::bigint AS n
FROM documents, unnest(categories) AS cat
WHERE deleted_at IS NULL AND published_at IS NOT NULL
GROUP BY 1, 2, 3, 4
WITH DATA;

-- Unique index is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS mv_coverage_pk ON mv_coverage (month, category, status, indexing_tier);
CREATE INDEX IF NOT EXISTS mv_coverage_category ON mv_coverage (category);
CREATE INDEX IF NOT EXISTS mv_coverage_status ON mv_coverage (status);
