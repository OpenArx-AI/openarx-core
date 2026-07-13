-- 033: Drop the legacy coverage_map table.
--
-- Coverage tracking moved to the per-document registry (documents.status:
-- listed -> downloaded -> ... -> ready | failed; epics openarx-tvts/j173).
-- The doctor 'registry-gaps' check replaced the coverage_map-based
-- 'coverage-gaps'/'coverage-breakdown-drift' checks, get_system_stats now
-- derives its date range from documents.published_at, and the runner no
-- longer writes the table (syncCoverageMap/refreshCoverageForDate/
-- bumpCoverageExpected removed). No code references coverage_map anymore.
--
-- idx_coverage_status and the breakdown column (migration 018) are dropped
-- with the table.

DROP TABLE IF EXISTS coverage_map;
