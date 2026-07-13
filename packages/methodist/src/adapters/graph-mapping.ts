// ── graph-mapping adapter (§12.7 · schema-driven · I1) ───────────────────────
//
// Maps ONE record + its `node` schema block to the arguments of a Neo4j upsert
// (`neoPut(label, 'id', key, data, scalars)`): the label is the record type, the key is
// the record id, the FULL record is the `_data` blob, and the schema's `indexed_properties`
// become the native (queryable) scalar properties.
//
// I1 (attester): the schema lists `attester_id` among `indexed_properties` for every
// scientific record, so the attester — the LED agent for claim/relation/activity/metric,
// the methodist/system for assessments — is indexed and queryable. This adapter does NOT
// SET the attester (that is the write-set's job, upstream in write-graph-records, which
// also enforces I3: GO → claims+bundle+vector, RETURN → only a checkpoint_return activity);
// it faithfully PROJECTS whatever indexed_properties the schema declares.
//
// Pure — no I/O. Replaces the hardcoded `{ attester_id }` scalars at
// mcp/profiles/methodist-v2/store-provider.ts.

export interface NodeSchema {
  indexed_properties?: string[];
}

/** §12.8 Model-C companion edge: a thin DETERMINISTIC projection of a `relation` record onto a
 *  traversable typed edge. The relation-TYPE is the Neo4j RELATIONSHIP LABEL (native rel-type
 *  traversal + count; new type → new label, additive §9.3) — NOT a property on a generic edge.
 *  The edge carries ONLY `rel_id` (a pointer to the node-record); full attributes live on the
 *  node. No truth of its own (reproducible from the node), OUTSIDE every §4.3 hash-scope, and
 *  supports native variable-length `[:TYPE*1..N]` multi-hop traversal. */
export interface GraphEdgeProjection {
  /** source claim id (physical edge tail; canonical endpoint order for symmetric types). */
  source: string;
  /** target claim id (physical edge head). */
  target: string;
  /** the relation record's canonical id — the ONLY property the edge carries. */
  relId: string;
  /** the Neo4j relationship LABEL, derived from the relation type (uppercased + sanitized). */
  label: string;
}

/** Canonical Neo4j relationship LABEL from a relation-type value + its class (§12.8 (c), Vlad-ratified).
 *  Uppercase, non-[A-Z0-9_]→`_`, empty → RELATED (label-injection-safe — pre-sanitized, cannot be
 *  parameterized in Cypher). ENGINEERING relations get a distinct `ENG_` namespace
 *  (ENG_DEPENDS_ON/ENG_SATISFIES/…) so the scientific multi-hop + metrics (`[:SUPPORT|EXTEND|…]`,
 *  claim_survival/P14/CTran/convergence) match ONLY the §7 EPISTEMIC labels and NEVER an engineering
 *  edge — non-confounding is STRUCTURAL (by label-space), no property filter. `relationClass` defaults
 *  to epistemic (the §7 ontology), so an untagged relation keeps its prior §7 label. */
const ENGINEERING_LABEL_PREFIX = 'ENG_';
export function relationLabel(relationType: string, relationClass?: string): string {
  const base = relationType.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  const core = base.length > 0 ? base : 'RELATED';
  return relationClass === 'engineering' ? ENGINEERING_LABEL_PREFIX + core : core;
}

/** Symmetric relation types traverse undirected; their companion edge is stored in a CANONICAL
 *  endpoint order (smaller id first) so the projection is deterministic regardless of record order. */
const SYMMETRIC_RELATIONS = new Set(['same_as']);

export interface GraphNodeMapping {
  /** Neo4j label = the record type. */
  label: string;
  /** node key (the `id` merge key). */
  key: string;
  /** native indexed scalar properties (schema `indexed_properties`, present + primitive-only). */
  scalars: Record<string, string | number | boolean>;
  /** the full record, stored as the `_data` blob. */
  data: Record<string, unknown>;
  /** §12.8: present for `relation` records — the companion traversal edge to project atomically
   *  alongside the node (undefined for non-relation records / a relation missing its endpoints). */
  edge?: GraphEdgeProjection;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Map a record to its Neo4j node upsert shape, driven by the schema's `node` block. For a
 *  `relation` record it ALSO returns the companion edge projection (§12.8 Model C). */
export function graphMapping(
  recordType: string,
  record: Record<string, unknown>,
  nodeSchema: NodeSchema | undefined,
): GraphNodeMapping {
  const scalars: Record<string, string | number | boolean> = {};
  for (const p of nodeSchema?.indexed_properties ?? []) {
    const v = record[p];
    // native Neo4j properties are primitives only; a non-primitive indexed_property stays
    // in the _data blob (unindexed) rather than being coerced.
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') scalars[p] = v;
  }
  const mapping: GraphNodeMapping = {
    label: recordType,
    key: String(record.id ?? ''),
    scalars,
    data: record,
  };
  // §12.8: a relation record projects a companion typed edge (:claim)-[:LABEL {rel_id}]->(:claim),
  // LABEL = the relation type. Only when both endpoints are present — a relation missing source/
  // target has no traversable projection (the node-record still persists as the source of truth).
  if (recordType === 'relation') {
    // §12.8 (c): the record's relation_class ('epistemic' [default] | 'engineering') selects the edge
    // LABEL namespace (§7 vs ENG_*). Store it as an indexed scalar so reclassify + class-scoped reads
    // filter on it; `record_type` stays "relation" (one family, Model C — node holds the record).
    // relation_class is projection-only — NOT in the §4.3 relation hash-scope (identity stays on the
    // scientific fields source/target/relation/direction/citation_context; the class pairs with the
    // relation type, so identity is unaffected).
    const relationClass = str(record.relation_class) || 'epistemic';
    mapping.scalars.relation_class = relationClass;
    let source = str(record.source_claim_id);
    let target = str(record.target_claim_id);
    if (source && target) {
      const relationType = str(record.relation);
      // Symmetric types (same_as) traverse undirected — store in canonical endpoint order (smaller
      // id first) so the projection is deterministic regardless of the record's endpoint order.
      if (SYMMETRIC_RELATIONS.has(relationType) && target < source) [source, target] = [target, source];
      mapping.edge = {
        source,
        target,
        relId: String(record.id ?? ''),
        label: relationLabel(relationType, relationClass),
      };
    }
  }
  return mapping;
}
