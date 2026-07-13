// ── Neo4j client + KV helpers (wave-v2 F2.1 graph adapter) ───────────────────
//
// Server-side, loopback bolt (NEO4J_URL/USER/PASSWORD in .env). The methodist
// runtime's async StoreProvider maps its `run-state` / `graph` / `activities`
// stores onto Neo4j nodes through these helpers.
//
// KV pattern: a labeled node keyed by `keyProp` stores the FULL record as a
// `_data` JSON blob plus a few indexed scalar properties (Neo4j properties cannot
// be nested objects — `dose`, `go_marks`, `activity_content` etc. would fail as
// native props). `neoGet` parses `_data` back. Labels/keyProps are code-controlled
// (never user input).

import neo4j, { type Driver } from 'neo4j-driver';

let driver: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!driver) {
    const url = process.env.NEO4J_URL;
    const user = process.env.NEO4J_USER;
    const pass = process.env.NEO4J_PASSWORD;
    if (!url || !user || !pass) throw new Error('NEO4J_URL / NEO4J_USER / NEO4J_PASSWORD required');
    driver = neo4j.driver(url, neo4j.auth.basic(user, pass));
  }
  return driver;
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

/** Fetch a node's record (parsed from its `_data` blob); undefined if absent. */
export async function neoGet(
  label: string,
  keyProp: string,
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const session = getNeo4jDriver().session();
  try {
    const r = await session.run(`MATCH (n:\`${label}\` {\`${keyProp}\`: $key}) RETURN n._data AS data`, { key });
    if (r.records.length === 0) return undefined;
    const data = r.records[0].get('data') as string | null;
    return data ? (JSON.parse(data) as Record<string, unknown>) : {};
  } finally {
    await session.close();
  }
}

/** Find a node by its `id` across labels — returns the record TYPE (Neo4j label) alongside
 *  the record. Used by the graph read handle for schema-driven / multi-type reads where the
 *  record type is not known ahead of the lookup (§12.7 read projection keys the schema off it).
 *  Scientific records (claim/relation/activity/metric/bundle) carry `id`; process nodes (run…)
 *  are keyed by `run_id`, so they are not matched here — the read surface stays scientific-only. */
export async function neoGetAny(
  id: string,
): Promise<{ record_type: string; record: Record<string, unknown> } | undefined> {
  const session = getNeo4jDriver().session();
  try {
    const r = await session.run('MATCH (n {id: $id}) RETURN labels(n)[0] AS label, n._data AS data LIMIT 1', { id });
    if (r.records.length === 0) return undefined;
    const label = r.records[0].get('label') as string | null;
    const data = r.records[0].get('data') as string | null;
    return { record_type: label ?? '', record: data ? (JSON.parse(data) as Record<string, unknown>) : {} };
  } finally {
    await session.close();
  }
}

/** Upsert a node: full record → `_data` JSON blob + indexed scalar properties. */
export async function neoPut(
  label: string,
  keyProp: string,
  key: string,
  record: Record<string, unknown>,
  scalars: Record<string, string | number | boolean> = {},
): Promise<void> {
  const session = getNeo4jDriver().session();
  try {
    await session.run(
      `MERGE (n:\`${label}\` {\`${keyProp}\`: $key}) SET n._data = $data, n += $scalars`,
      { key, data: JSON.stringify(record), scalars },
    );
  } finally {
    await session.close();
  }
}

/** §12.8 Model C: upsert a `relation` record as BOTH the node-record (source of truth, same
 *  _data + indexed scalars as any node) AND its companion traversal edge — ATOMICALLY, in one
 *  transaction (one Cypher statement). The edge is TYPED: the relation type is the Neo4j
 *  RELATIONSHIP LABEL — `(:claim)-[:SUPPORTS|SAME_AS|DISPUTES|… {rel_id}]->(:claim)` — for native
 *  rel-type traversal + count, and variable-length `[:TYPE*1..N]` multi-hop out of the box (no
 *  1-hop limit). The edge carries ONLY rel_id (a pointer to the node; type is the label, full
 *  attributes on the node); it is keyed by rel_id (idempotent) and OUTSIDE every §4.3 hash-scope
 *  (identity lives on the node). Endpoints via OPTIONAL MATCH — the edge is created only when BOTH
 *  claim nodes already exist; the write-set is committed claims-before-relations so a same-bundle
 *  relation always finds its endpoints (dangling does not arise by construction). No stub nodes. */
export async function neoPutRelation(
  key: string,
  record: Record<string, unknown>,
  scalars: Record<string, string | number | boolean>,
  edge: { source: string; target: string; label: string },
): Promise<void> {
  // The relationship type cannot be parameterized in Cypher, so `label` is interpolated as a
  // literal — SAFE: it is pre-sanitized to [A-Z0-9_] by relationLabel; re-validated here as
  // defense-in-depth (injection-proof), falling back to RELATED on any anomaly.
  const label = /^[A-Z0-9_]+$/.test(edge.label) ? edge.label : 'RELATED';
  const session = getNeo4jDriver().session();
  try {
    const res = await session.run(
      `MERGE (n:\`relation\` {id: $key}) SET n._data = $data, n += $scalars
       WITH n
       OPTIONAL MATCH (a:\`claim\` {id: $source})
       OPTIONAL MATCH (b:\`claim\` {id: $target})
       FOREACH (_ IN CASE WHEN a IS NOT NULL AND b IS NOT NULL THEN [1] ELSE [] END |
         MERGE (a)-[e:\`${label}\` {rel_id: $key}]->(b))
       RETURN a IS NOT NULL AS srcFound, b IS NOT NULL AS tgtFound`,
      { key, data: JSON.stringify(record), scalars, source: edge.source, target: edge.target },
    );
    // methodist write-path observability (openarx-, Vlad): a relation node ALWAYS merges, but the
    // companion edge is created only when BOTH claim endpoints already exist. Log the endpoint match
    // + edges created so a silently-missing edge (endpoint id mismatch → OPTIONAL MATCH null) is
    // visible instead of a mysterious 0-edges graph.
    const row = res.records[0];
    const srcFound = row?.get('srcFound') === true;
    const tgtFound = row?.get('tgtFound') === true;
    const edgesCreated = res.summary.counters.updates().relationshipsCreated;
    console.error(
      JSON.stringify({
        at: 'neoPutRelation',
        rel_id: key.slice(0, 48),
        label,
        source: edge.source.slice(0, 48),
        target: edge.target.slice(0, 48),
        srcFound,
        tgtFound,
        edgesCreated,
        ...(srcFound && tgtFound ? {} : { WARN: 'endpoint(s) NOT found — edge NOT drawn' }),
      }),
    );
  } finally {
    await session.close();
  }
}

/** Live cheap graph counts for the methodist stats page (Console 694n): node counts by label
 *  + relationship counts by type. Neo4j maintains these, so the queries are ~O(1) — safe to
 *  serve live without a rollup. */
export async function neoGraphCounts(): Promise<{ nodes: Record<string, number>; edges: Record<string, number> }> {
  const session = getNeo4jDriver().session();
  try {
    const nres = await session.run('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS c');
    const eres = await session.run('MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c');
    const nodes: Record<string, number> = {};
    for (const r of nres.records) {
      const label = r.get('label') as string | null;
      if (label) nodes[label] = (r.get('c') as { toNumber(): number }).toNumber();
    }
    const edges: Record<string, number> = {};
    for (const r of eres.records) edges[r.get('t') as string] = (r.get('c') as { toNumber(): number }).toNumber();
    return { nodes, edges };
  } finally {
    await session.close();
  }
}

/** Delete a node (test cleanup / supersede). */
export async function neoDelete(label: string, keyProp: string, key: string): Promise<void> {
  const session = getNeo4jDriver().session();
  try {
    await session.run(`MATCH (n:\`${label}\` {\`${keyProp}\`: $key}) DETACH DELETE n`, { key });
  } finally {
    await session.close();
  }
}
