-- 046_wave_v2_credential_dossier.sql
-- Wave v2 (approach B, clean rebuild) — layer_2_pillar.md §12.2 + methodist_framework_v2.md §7.
--
-- Relational identity + competence (NOT graph):
--   credential — the agent identity (credential_id). The graph references it as a
--     PROPERTY of the `run` node, NOT as a graph node (reversal of the earlier
--     "credential = graph node", Vlad D3).
--   dossier — a FLAT, overwritten-in-place competence map fed to the model:
--     autonomy_by_context (PER-CYCLE — NOT an A0/A1/A2 ladder), passed_units,
--     tier_by_context (tier-gate, §7), patches_received, corrections.
--
-- ADDITIVE + non-destructive: the old methodist_* (044/045) and layer2_* tables are
-- KEPT until the confirmed transition (§12.6 fact-check hold). This migration does
-- NOT drop them; the new dossier-store supersedes the 044/045 dossier *role*.

CREATE TABLE IF NOT EXISTS credential (
  credential_id   text PRIMARY KEY,                     -- stable agent identity
  portal_user_id  text,                                 -- optional link to Portal identity
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credential_portal ON credential (portal_user_id);

CREATE TABLE IF NOT EXISTS dossier (
  credential_id        text PRIMARY KEY,                -- one dossier per credential
  autonomy_by_context  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-cycle autonomy map (NOT a ladder)
  passed_units         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier_by_context      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- methodology tier per model capability (§7 tier-gate)
  patches_received     jsonb NOT NULL DEFAULT '[]'::jsonb,
  corrections          jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
