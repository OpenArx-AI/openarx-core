// Wave v2 (approach B) — Neo4j graph schema (layer_2_pillar.md §12.1).
//
// Apply on S1 via cypher-shell (loopback bolt); idempotent (IF NOT EXISTS).
// Process nodes run/intent/decision are INTERNAL — never projected outward
// (§12.4); the read tools know only scientific node types. Per-field layout is
// refined by experiment (§12.1 — not a blocker), so only id-uniqueness + the
// obvious lookup indexes are declared here.
//
// Clean-slate wipe is a SEPARATE, gated step (see wave_v2_clean_slate.cypher) —
// this file only declares schema and is safe to re-run.

// ── process nodes (§12.1) — internal ─────────────────────────────────────────
CREATE CONSTRAINT run_id IF NOT EXISTS FOR (r:run) REQUIRE r.run_id IS UNIQUE;
CREATE CONSTRAINT intent_id IF NOT EXISTS FOR (i:intent) REQUIRE i.intent_id IS UNIQUE;
CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (d:decision) REQUIRE d.decision_id IS UNIQUE;

// run lookups: by mentee (credential_id is a property/reference, not a node) + status
CREATE INDEX run_credential IF NOT EXISTS FOR (r:run) ON (r.credential_id);
CREATE INDEX run_status IF NOT EXISTS FOR (r:run) ON (r.status);
CREATE INDEX run_parent IF NOT EXISTS FOR (r:run) ON (r.parent_run_id);

// ── scientific nodes (§1) — id-uniqueness (content-derived ids, JCS §4.3) ─────
CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (c:claim) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT relation_id IF NOT EXISTS FOR (r:relation) REQUIRE r.id IS UNIQUE;
CREATE CONSTRAINT activity_id IF NOT EXISTS FOR (a:activity) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT metric_id IF NOT EXISTS FOR (m:metric) REQUIRE m.id IS UNIQUE;
CREATE CONSTRAINT bundle_id IF NOT EXISTS FOR (b:bundle) REQUIRE b.id IS UNIQUE;
