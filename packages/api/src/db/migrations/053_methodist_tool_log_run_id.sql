-- 053_methodist_tool_log_run_id.sql
-- §8-inv4 run_id-threading (contracts "EMPTY_LOG KEYING FIX"; bead openarx-num1).
-- Additive, forward-only, NO backfill: attribute a tool-log row to its RUN directly (run-anchored),
-- so the checkpoint crosscheck reads usage by run_id — immune to the token-refresh credential
-- divergence that made credentialFromToken(userId|tokenId) diverge mid-run and the crosscheck see an
-- empty log (false inconclusive/re-auth). A mentee threads run_id on a research-tool call (validated
-- against the run's stable owner_hash at the boundary; a foreign/absent run_id is REJECT-HARD);
-- the row then carries run_id. Un-threaded rows keep run_id NULL and are read via the
-- credential+window FALLBACK (dual-key transition — see listRunToolLog), so the rollout orphans
-- nothing and old calls never hard-fail.

ALTER TABLE methodist_tool_log ADD COLUMN IF NOT EXISTS run_id text;
CREATE INDEX IF NOT EXISTS idx_methodist_tool_log_run ON methodist_tool_log (run_id, called_at) WHERE run_id IS NOT NULL;
