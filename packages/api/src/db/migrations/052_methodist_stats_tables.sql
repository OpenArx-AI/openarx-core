-- 052_methodist_stats_tables.sql
-- Console methodist+layer2 stats page (openarx-694n, Vlad-approved; contracts sign-off §12.2,
-- 2026-07-12). Two ADDITIVE admin-relational tables — they do NOT touch the (torn-down) layer2
-- record-graph, are not identity/§4.3, and are admin-facing (I2 not affected).

-- Per-call door-model LLM cost ledger. Today the methodist judging calls only LOG the ROI
-- (`at:methodist.model-call`); this persists them so Console can show the cost breakdown +
-- cache-hit rate. cached_tokens = the cache-READ subset (Gemini implicit caching's
-- cachedContentTokenCount) — Gemini has NO cache-WRITE cost line (unlike Anthropic), so no
-- cache_write column (a later explicit-cache fork would add one, additively). cost = §5.1-bis
-- split (uncached_input×rate + cached×0.10×rate + output×rate).
CREATE TABLE IF NOT EXISTS methodist_llm_costs (
  id             bigserial PRIMARY KEY,
  at             timestamptz  NOT NULL DEFAULT now(),
  door           text,                          -- diagnose | checkpoint | ask | verify (the call-site; nullable until threaded)
  model          text         NOT NULL,
  input_tokens   integer      NOT NULL,
  cached_tokens  integer      NOT NULL DEFAULT 0,
  output_tokens  integer      NOT NULL,
  cost           numeric(14,8) NOT NULL,
  run_id         text,                          -- nullable (admin-slicing)
  credential_id  text,                          -- per-AGENT composite, nullable
  methodology_version text                      -- per-version cost slice
);
CREATE INDEX IF NOT EXISTS idx_methodist_llm_costs_at ON methodist_llm_costs (at);
CREATE INDEX IF NOT EXISTS idx_methodist_llm_costs_version ON methodist_llm_costs (methodology_version);

-- Periodic (hour/day) snapshot of the heavy Neo4j claim breakdowns (B2) — Console reads the
-- latest batch (max(rolled_at)) instead of hitting Neo4j per request (mv_coverage pattern). Cheap
-- counts (node-label / rel-type / Qdrant) are served LIVE via /methodist-graph-counts, NOT here.
-- Tall form (dimension/bucket/count) — extensible. claim_status buckets = the epistemic kinds
-- (§12.7-ter KNOWN_CLAIM_STATUSES: empirical_result/theorem/…), undeclared → null bucket.
CREATE TABLE IF NOT EXISTS methodist_graph_rollup (
  rolled_at      timestamptz  NOT NULL DEFAULT now(),
  methodology_version text,
  dimension      text         NOT NULL,         -- claim_type | claim_status | modality | top_attester
  bucket         text,                          -- the category value (null = undeclared)
  count          integer      NOT NULL,
  verified_count integer      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_methodist_graph_rollup_rolled ON methodist_graph_rollup (rolled_at, dimension);
