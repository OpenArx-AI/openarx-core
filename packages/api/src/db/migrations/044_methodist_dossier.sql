-- 044_methodist_dossier.sql
-- A5 methodist channel (mcp_profiles_v3.md §13). Methodist-INTERNAL operational
-- state — distinct from the open Layer 2 graph (each exchange ALSO writes a Layer 2
-- activity per §13.3 inv.4). Powers the deterministic mechanics: the mechanical
-- stop-rule (a recorded GO per stage), hash-idempotency of hand-ins, and dossier
-- transparency. The Gemini 3 Pro carrier (dose/diagnosis CONTENT) is second-tempo
-- and does not touch these tables' shape.

-- Mentee dossier — one row per credential (the mentee's stable identity).
CREATE TABLE IF NOT EXISTS methodist_dossier (
  credential_id   text PRIMARY KEY,
  autonomy        text NOT NULL DEFAULT 'A0',          -- A0 | A1 | A2 (external ceiling A2, §13.4)
  cycles_passed   text[] NOT NULL DEFAULT '{}',
  patches         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- correction / patch history
  track_record    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Checkpoint journal — every stage hand-in. `go` marks that this checkpoint issued
-- GO for `stage` (the mechanical stop-rule reads it); `handin_hash` is unique so a
-- resubmitted hand-in replays the stored response (idempotency, inv.2).
CREATE TABLE IF NOT EXISTS methodist_checkpoints (
  id             bigserial PRIMARY KEY,
  credential_id  text NOT NULL,
  stage          text NOT NULL,                        -- stage id (text — tolerate non-numeric stages)
  handin_hash    text NOT NULL,                        -- sha256 of {credential_id,stage,track_note,artifacts}
  response       jsonb NOT NULL,                        -- stored response for idempotent replay
  go             boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_methodist_ckpt_handin ON methodist_checkpoints (handin_hash);
CREATE INDEX IF NOT EXISTS idx_methodist_ckpt_cred_stage ON methodist_checkpoints (credential_id, stage);
CREATE INDEX IF NOT EXISTS idx_methodist_ckpt_go ON methodist_checkpoints (credential_id, stage) WHERE go = true;

-- Escalations — arbitration above the methodist (inv.5). Resolution returns via the
-- next checkpoint response or get_my_development.
CREATE TABLE IF NOT EXISTS methodist_escalations (
  ticket         text PRIMARY KEY,
  credential_id  text NOT NULL,
  review_run_id  text,
  issue          text NOT NULL,
  class          text NOT NULL,                         -- construction | methodology | platform
  status         text NOT NULL DEFAULT 'open',
  resolution     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_methodist_esc_cred ON methodist_escalations (credential_id);
