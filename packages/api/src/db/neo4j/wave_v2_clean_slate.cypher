// Wave v2 clean-slate — CLEARS ALL GRAPH DATA (layer_2_pillar.md §12.6, Vlad 2026-07-08).
//
// DESTRUCTIVE. Run ONCE under Vlad's explicit go, BEFORE applying wave_v2_schema.cypher.
// The migrated data are experimental probes through a drifted 0375; no users → wiped.
// Physics (the Neo4j install) is NOT touched; Postgres data is NOT restored into the graph.
// Neo4j has an offline-dump backup (backup-neo4j.sh) — this is recoverable if needed.

MATCH (n) DETACH DELETE n;
