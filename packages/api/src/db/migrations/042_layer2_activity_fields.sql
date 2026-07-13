-- 042_layer2_activity_fields.sql
-- A3 (final wave 2026-07-05, pillar §5, bead openarx-contracts-31du / Core openarx-gnrk):
-- activity `applied_instrument` + `genre` optional fields. They describe WHAT the
-- activity was (which instrument drove it, which methodological genre it belongs to),
-- so they are hash-INCLUDED when present (part of the activity's content). Absent-by-
-- omission per RFC 8785 (§4.3): existing activity content_hashes are unchanged — no
-- id shift, golden vectors stay frozen. They let the methodist channel (§13, invariant 4)
-- and audit tooling classify activities WITHOUT parsing free-text activity_content.

ALTER TABLE layer2_activities ADD COLUMN IF NOT EXISTS applied_instrument text;
ALTER TABLE layer2_activities ADD COLUMN IF NOT EXISTS genre text;

-- Partial indexes: classification/audit filters over the (sparse) populated rows only.
CREATE INDEX IF NOT EXISTS idx_l2_act_genre
  ON layer2_activities (genre) WHERE genre IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_l2_act_applied_instrument
  ON layer2_activities (applied_instrument) WHERE applied_instrument IS NOT NULL;
