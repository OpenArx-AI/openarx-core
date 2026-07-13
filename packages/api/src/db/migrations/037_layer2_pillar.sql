-- 037_layer2_pillar.sql
-- Layer 2 — Claims & Relations Pillar, Phase-1 Postgres storage (5 tables).
-- Contract: openarx-contracts/contracts/layer_2_pillar.md §5 + MASTER_CONTRACT §11.
-- Bead openarx-contracts-kk4j.
--
-- GRAPH-FRIENDLY INVARIANTS (contract §5.1 — Core is bound to preserve for the
-- eventual mechanical Neo4j migration):
--   1. No auto-increment / surrogate keys. Every id is text = {source_prefix}:{record_type}:{content_hash}.
--   2. Relations are first-class rows; claim references are PLAIN STRING columns.
--   3. JSONB only for record-INTERNAL fields (content, evidence, mediator, activity_content,
--      citation_context, cycle_context, manifest, verification, edge_provenance).
--      NEVER JSONB for inter-record topology. Multi-valued id references (activity
--      wasAssociatedWith/used/generated/wasInformedBy, claim authority_chain) are native
--      text[] arrays of plain string ids — NOT JSONB — so they map to Neo4j edges.
--   4. Indexes on every graph-traversal field (source_claim_id, target_claim_id, relation,
--      attester_id, cycle_context.run_id, + GIN on the activity edge-arrays).
--   5. No cross-record FKs / compound keys (supersedes / source_claim_id / target_claim_id
--      are plain string references, deliberately NOT foreign keys — Neo4j has none).
--   6. Vector embeddings live in Qdrant, not here (sync deferred, contract Q3).
--
-- Per-record columns:
--   canonical_bytes  — the exact RFC 8785 JCS serialization used to derive content_hash;
--                      persisted for BYTE-EXACT idempotency vs id_collision (contract §8.4, Q5).
--   portal_user_id   — owner from POST /api/internal/verify-token at write time (deliverable #8,
--                      §4.4); NULL for platform:algorithm records (no owner).
--   consent_scope    — three-value enum retained as reserved schema position (§4.6); DB CHECK
--                      allows all three, the SERVER enforces 'public_read' only in Phase 1.
--   supersedes       — plain string ref to the record this one supersedes (§4.2), nullable.

-- ── claims ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS layer2_claims (
  id              text PRIMARY KEY,
  attester_id     text NOT NULL,
  attested_at     timestamptz NOT NULL,
  content         jsonb NOT NULL,
  evidence        jsonb NOT NULL,
  chain_complete  boolean NOT NULL,
  source_digest   text NOT NULL,
  cycle_context   jsonb,
  authority_chain text[],
  verification    jsonb,
  consent_scope   text NOT NULL DEFAULT 'public_read'
                    CHECK (consent_scope IN ('internal', 'platform_wide', 'public_read')),
  supersedes      text,
  portal_user_id  text,
  canonical_bytes text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_l2_claims_attester ON layer2_claims (attester_id);
CREATE INDEX IF NOT EXISTS idx_l2_claims_run ON layer2_claims ((cycle_context ->> 'run_id'));
CREATE INDEX IF NOT EXISTS idx_l2_claims_supersedes ON layer2_claims (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_l2_claims_owner ON layer2_claims (portal_user_id) WHERE portal_user_id IS NOT NULL;

-- ── relations (first-class edges) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS layer2_relations (
  id                       text PRIMARY KEY,
  attester_id              text NOT NULL,
  attested_at              timestamptz NOT NULL,
  source_claim_id          text NOT NULL,
  target_claim_id          text NOT NULL,
  relation                 text NOT NULL,
  direction                text NOT NULL,
  citation_context         jsonb NOT NULL,
  edge_provenance          jsonb NOT NULL,
  mediator                 jsonb,
  shared_source_uri        text,
  interpretation_difference text,
  consent_scope            text NOT NULL DEFAULT 'public_read'
                             CHECK (consent_scope IN ('internal', 'platform_wide', 'public_read')),
  supersedes               text,
  portal_user_id           text,
  canonical_bytes          text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_l2_rel_source ON layer2_relations (source_claim_id);
CREATE INDEX IF NOT EXISTS idx_l2_rel_target ON layer2_relations (target_claim_id);
CREATE INDEX IF NOT EXISTS idx_l2_rel_relation ON layer2_relations (relation);
CREATE INDEX IF NOT EXISTS idx_l2_rel_attester ON layer2_relations (attester_id);
CREATE INDEX IF NOT EXISTS idx_l2_rel_supersedes ON layer2_relations (supersedes) WHERE supersedes IS NOT NULL;

-- ── activities (PROV-O) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS layer2_activities (
  id                  text PRIMARY KEY,
  attester_id         text NOT NULL,
  attested_at         timestamptz NOT NULL,
  activity_type       text NOT NULL,
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz NOT NULL,
  was_associated_with text[] NOT NULL DEFAULT '{}',
  used                text[] NOT NULL DEFAULT '{}',
  generated           text[] NOT NULL DEFAULT '{}',
  was_informed_by     text[] NOT NULL DEFAULT '{}',
  activity_content    jsonb NOT NULL,
  consent_scope       text NOT NULL DEFAULT 'public_read'
                        CHECK (consent_scope IN ('internal', 'platform_wide', 'public_read')),
  supersedes          text,
  portal_user_id      text,
  canonical_bytes     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_l2_act_attester ON layer2_activities (attester_id);
CREATE INDEX IF NOT EXISTS idx_l2_act_type ON layer2_activities (activity_type);
CREATE INDEX IF NOT EXISTS idx_l2_act_run ON layer2_activities ((activity_content -> 'cycle_context' ->> 'run_id'));
-- GIN on edge-arrays for reverse traversal ("activities that generated/used/were-informed-by X")
CREATE INDEX IF NOT EXISTS idx_l2_act_generated ON layer2_activities USING gin (generated);
CREATE INDEX IF NOT EXISTS idx_l2_act_used ON layer2_activities USING gin (used);
CREATE INDEX IF NOT EXISTS idx_l2_act_informed ON layer2_activities USING gin (was_informed_by);

-- ── metrics ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS layer2_metrics (
  id               text PRIMARY KEY,
  attester_id      text NOT NULL,
  attested_at      timestamptz NOT NULL,
  metric_name      text NOT NULL,
  metric_value     double precision NOT NULL,
  metric_type      text NOT NULL,
  computation      text NOT NULL,
  was_generated_by text NOT NULL,
  measures_entity  text NOT NULL,
  cycle_context    jsonb NOT NULL,
  consent_scope    text NOT NULL DEFAULT 'public_read'
                     CHECK (consent_scope IN ('internal', 'platform_wide', 'public_read')),
  supersedes       text,
  portal_user_id   text,
  canonical_bytes  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_l2_met_attester ON layer2_metrics (attester_id);
CREATE INDEX IF NOT EXISTS idx_l2_met_name ON layer2_metrics (metric_name);
CREATE INDEX IF NOT EXISTS idx_l2_met_genby ON layer2_metrics (was_generated_by);
CREATE INDEX IF NOT EXISTS idx_l2_met_measures ON layer2_metrics (measures_entity);
CREATE INDEX IF NOT EXISTS idx_l2_met_run ON layer2_metrics ((cycle_context ->> 'run_id'));

-- ── bundles (RO-Crate) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS layer2_bundles (
  id              text PRIMARY KEY,
  attester_id     text NOT NULL,
  attested_at     timestamptz NOT NULL,
  manifest        jsonb NOT NULL,
  consent_scope   text NOT NULL DEFAULT 'public_read'
                    CHECK (consent_scope IN ('internal', 'platform_wide', 'public_read')),
  supersedes      text,
  portal_user_id  text,
  canonical_bytes text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_l2_bundle_attester ON layer2_bundles (attester_id);
CREATE INDEX IF NOT EXISTS idx_l2_bundle_supersedes ON layer2_bundles (supersedes) WHERE supersedes IS NOT NULL;
