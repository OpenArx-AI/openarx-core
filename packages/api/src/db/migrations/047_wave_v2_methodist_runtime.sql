-- 047_wave_v2_methodist_runtime.sql
-- Wave-v2 methodist door-engine runtime stores (F2.3). Two PG-backed stores the
-- door interpreter needs beyond Neo4j (run/graph) and the credential/dossier tables:
--
-- (1) methodist_run_journal — RUN-scoped journal. Serves two door primitives:
--     * append-journal writes door exchange events (diagnose/checkpoint/course/…):
--       run_id + event + payload, tool NULL.
--     * crosscheck-tool-usage reconciles claimed_usage against the LIVE tool-log
--       (§8 inv-4 anti-gaming): entries with run_id + tool (event NULL), written by
--       MCP call-interception. 045_methodist_journal is credential-keyed process-
--       exchange — wrong grain (no run_id) for the per-run crosscheck.
--
-- (2) methodist_idempotency — check-idempotency (submission_hash → prior published
--     ref) so a re-submitted hand-in maps to its prior outcome, not a double-write.

CREATE TABLE IF NOT EXISTS methodist_run_journal (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL,
  tool        text,          -- live tool-log entry (MCP call-interception); NULL for exchange events
  event       text,          -- door exchange event (diagnose/checkpoint/…); NULL for tool-log entries
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_methodist_run_journal_run ON methodist_run_journal (run_id, created_at);

CREATE TABLE IF NOT EXISTS methodist_idempotency (
  key         text PRIMARY KEY,   -- `${scope}:${submission_hash}` (scope defaults to run_id)
  ref         text NOT NULL,      -- the prior committed/published ref (bundle_id / activity id)
  created_at  timestamptz NOT NULL DEFAULT now()
);
