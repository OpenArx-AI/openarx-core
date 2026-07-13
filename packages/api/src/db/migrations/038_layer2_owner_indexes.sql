-- 038_layer2_owner_indexes.sql
-- Partial owner indexes for the Portal portfolio listing (pillar §6.2 patch,
-- contracts commit 7e8034e): GET /api/internal/layer2/user-records lists
-- records WHERE portal_user_id = <user>. layer2_claims already has
-- idx_l2_claims_owner (migration 037); mirror it on the other four tables.
-- Partial (IS NOT NULL) — platform:algorithm records have no owner.

CREATE INDEX IF NOT EXISTS idx_l2_rel_owner
  ON layer2_relations (portal_user_id) WHERE portal_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_l2_act_owner
  ON layer2_activities (portal_user_id) WHERE portal_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_l2_met_owner
  ON layer2_metrics (portal_user_id) WHERE portal_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_l2_bundle_owner
  ON layer2_bundles (portal_user_id) WHERE portal_user_id IS NOT NULL;
