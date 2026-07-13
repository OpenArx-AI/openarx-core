-- 048_methodist_tool_log.sql
-- F2.3/Phase 3 live tool-log (bead openarx-4y79) — the REAL system call-log the methodist
-- crosscheck reconciles claimed_usage against (§8 inv-4 anti-gaming). Written by MCP
-- call-interception (gateway server.tool wrapper) for every researcher tool call,
-- keyed by the AUTH-token credential (boundary-1). The checkpoint crosscheck maps a
-- run to its credential + start-of-run window and reads the tools called in that window
-- (see listRunToolLog). This replaces the seeded stand-in used in the harness — the
-- verdict then reflects real usage, not an empty stub.

CREATE TABLE IF NOT EXISTS methodist_tool_log (
  id             bigserial PRIMARY KEY,
  credential_id  text NOT NULL,
  tool           text NOT NULL,
  called_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_methodist_tool_log_cred ON methodist_tool_log (credential_id, called_at);
