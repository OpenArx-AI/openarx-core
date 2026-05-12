-- 028: Per-day MCP tool cost aggregates for console-side pricing analysis.
--
-- Background (openarx-um8r, search v2 cost tracking Part 2):
-- Per-call raw data already lives in JSONL request log (see
-- request-logger.ts UsageLogFields). This table holds DAILY aggregates
-- accumulated via Redis HASH counters and synced by a 5-minute timer
-- inside the MCP service primary process. Not per-user — only need to
-- compare provider $cost vs charged credits to balance pricing.
--
-- Source of truth: Redis keys `mcp:cost:{date}:{cost_key}:{profile}`
-- with HASH fields. Sync UPSERT REPLACES counters (idempotent).
-- JSONL log is forensic only — no automatic recovery, per-user data
-- intentionally absent here (use JSONL grep for forensic).

CREATE TABLE IF NOT EXISTS mcp_tool_costs_daily (
  date date NOT NULL,
  cost_key text NOT NULL,                      -- 'find_evidence:fast', 'compare_papers:full', 'search:rerank' etc.
  tool text NOT NULL,                          -- denormalised: 'find_evidence' (for group-by without parsing)
  profile text NOT NULL,                       -- 'v1' / 'pub' / 'gov' / 'dev'

  invocations int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,

  -- LLM provider spend (Vertex / OpenRouter / etc.)
  llm_calls_total int NOT NULL DEFAULT 0,
  llm_input_tokens_total bigint NOT NULL DEFAULT 0,
  llm_output_tokens_total bigint NOT NULL DEFAULT 0,
  llm_cost_usd_total numeric(12,6) NOT NULL DEFAULT 0,

  -- Embed provider spend
  embed_calls_total int NOT NULL DEFAULT 0,
  embed_input_tokens_total bigint NOT NULL DEFAULT 0,
  embed_cost_usd_total numeric(12,6) NOT NULL DEFAULT 0,

  -- User-facing billing
  credits_charged_total int NOT NULL DEFAULT 0,

  -- Performance (avg = duration_ms_sum / invocations; max omitted —
  -- HINCRBY can't do compare-and-set without Lua, deferred for now)
  duration_ms_sum bigint NOT NULL DEFAULT 0,

  rollup_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (date, cost_key, profile)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_costs_tool_date
  ON mcp_tool_costs_daily(tool, date DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_costs_date
  ON mcp_tool_costs_daily(date DESC);

COMMENT ON TABLE mcp_tool_costs_daily IS
  'Daily aggregates of MCP tool invocations for pricing analysis. Source: Redis counters synced by MCP primary process every 5 min. Per-call raw data lives in $MCP_LOG_DIR/{YYYY-MM-DD}.jsonl.';
