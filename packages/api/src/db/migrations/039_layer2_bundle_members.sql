-- 039_layer2_bundle_members.sql
-- Bundle composition persistence (pillar §7.4 patch, contracts commit 9e1b596,
-- QA openarx-tester-wn8): ordered constituent record-ids on the bundle row.
--
-- members text[] — ordered array of record ids; bundle_position = array index.
-- Allowed §5.1 pattern (plain-string multi-valued refs, like activity edges) —
-- NOT jsonb topology. Hash-EXCLUDED: the bundle id still derives from the
-- manifest only (§4.3 hash-scope untouched — changing it is catastrophic).
--
-- NULL members = pre-039 legacy row (composition unknown), NOT an empty
-- composition. Empty composition is '{}'. Server-side no-accretion rule lives
-- in the store (submitBundleAtomic): identical composition → idempotent
-- success; differing composition → bundle_composition_conflict (422).

ALTER TABLE layer2_bundles ADD COLUMN IF NOT EXISTS members text[];
