-- 051_drop_layer2_graph_tables.sql
-- openarx-1woy — PG graph-layer TEARDOWN (completes the PG→Neo4j cutover; Vlad-approved via
-- contracts 2026-07-11). Neo4j is the canonical graph store; the methodist path (2c) writes
-- claim vectors DIRECTLY to Qdrant. The PG layer2 record-graph + its event outbox are no
-- longer written or read — both layer2_events consumers (the embed worker AND the §7.6 dedup
-- consumer) were disabled FIRST (commit e2eb924) so nothing errors on the dropped tables or
-- re-populates Qdrant from PG (the embed worker's hourly consistency audit would otherwise
-- re-enqueue the dropped claims).
--
-- SAFETY (§12.6-bis): an offline cold-dump of all six tables was taken BEFORE this migration —
-- /mnt/storagebox/openarx/backups/layer2_graph_teardown_1woy_20260711_181253.sql (3731 lines,
-- all 6 COPY blocks) — a recoverable net for this IRREVERSIBLE step.
--
-- FK-isolated: 0 FK constraints touch these tables (verified) → no CASCADE risk to any KEEP
-- table, no inter-table drop-order dependency.
--
-- KEEP (NOT touched): documents/chunks/document_* (corpus), dossier, ALL methodist_* runtime
-- tables (run_journal/idempotency/tool_log/dossier/checkpoints/escalations/journal),
-- portal_pending_uploads, source_registry, schema_version, cost/pipeline tables, and the
-- Qdrant `layer2_claims` collection STRUCTURE (its stale points are purged separately; the
-- Qdrant Layer2VectorStore + buildClaimProjection code STAYS — reused by the 2c methodist path).
--
-- FOLLOW-UP (staged, openarx-1woy): remove the now-dead PG-graph code FILES (layer2-embed-worker,
-- layer2-dedup-consumer, layer2-store PG write paths, layer2-events) in a separate careful PR,
-- preserving the Qdrant-side reuse.

DROP TABLE IF EXISTS layer2_activities;
DROP TABLE IF EXISTS layer2_bundles;
DROP TABLE IF EXISTS layer2_claims;
DROP TABLE IF EXISTS layer2_events;
DROP TABLE IF EXISTS layer2_metrics;
DROP TABLE IF EXISTS layer2_relations;
