-- 035: document_demand — per-document, per-day request demand counters (openarx-1nvk).
--
-- Demand signal used to auto-surface abstract_only documents that agents request
-- frequently → natural candidates for the next full-text re-index wave (turns the
-- manual selection, e.g. the hand-picked 31, into a self-improving pull loop).
--
-- Populated by an MCP-side Redis→Postgres rollup (packages/mcp/src/lib/
-- demand-rollup.ts), mirroring the cost rollup: per-call HINCRBY into
-- mcp:demand:{day}:{docId}, replaced into PG every ~5min. Absolute counts per
-- (document_id, day) → idempotent UPSERT, drift-free.
--
-- Two counters per Vlad/promo (openarx-164854): get_document = "attempted to
-- fetch (may bounce on abstract_only)" vs get_chunks = "actually read content".
-- Internal-only — never exposed to agents (avoids feedback loops / gaming).

CREATE TABLE IF NOT EXISTS document_demand (
  document_id        UUID    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  day                DATE    NOT NULL,
  get_document_count INTEGER NOT NULL DEFAULT 0,
  get_chunks_count   INTEGER NOT NULL DEFAULT 0,
  rollup_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, day)
);

CREATE INDEX IF NOT EXISTS document_demand_day ON document_demand (day);
