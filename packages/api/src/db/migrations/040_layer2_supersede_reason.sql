-- 040_layer2_supersede_reason.sql
-- F-8 link_supersedes (pillar, bead openarx-contracts-a2n9): post-hoc supersede
-- linking carries a reason. Column is hash-EXCLUDED metadata alongside the
-- supersedes pointer (known reasons: erratum | refinement | same_as — open set
-- per §9.3). NOT added to layer2_activities: the activity journal is immutable
-- by design decision (history is corrected by NEW activities via wasInformedBy,
-- never by superseding the record of what happened).

ALTER TABLE layer2_claims    ADD COLUMN IF NOT EXISTS supersede_reason text;
ALTER TABLE layer2_relations ADD COLUMN IF NOT EXISTS supersede_reason text;
ALTER TABLE layer2_metrics   ADD COLUMN IF NOT EXISTS supersede_reason text;
ALTER TABLE layer2_bundles   ADD COLUMN IF NOT EXISTS supersede_reason text;

-- Reverse-visibility (F-11) uses the existing idx_*_supersedes partial indexes;
-- metrics lacked one (037 added it only to claims/relations/bundles).
CREATE INDEX IF NOT EXISTS idx_l2_met_supersedes ON layer2_metrics (supersedes) WHERE supersedes IS NOT NULL;
