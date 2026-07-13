// ── Layer 2 — ingress validation (contract §8, bead openarx-contracts-kk4j) ──
//
// Levels (§8.1):
//   minimum        — schema conformance (+ id uniqueness, enforced by the store's
//                    idempotency/collision logic in layer2-store.ts). ALWAYS runs,
//                    BLOCKS on failure, cannot be disabled.
//   graph_consistency (opt-in) — referenced record ids exist; edge invariants
//                    (`qualify` requires mediator; conflicting edges → graph_conflict).
//   provenance     (opt-in) — evidence[].provenance consistent with claim_status
//                    (initial CoE policy); wasInformedBy activity chain complete.
//   all            — both opt-in levels.
//
// Opt-in failures are WARNINGS by default; `strict=true` escalates them to
// blocking errors (the MCP layer maps blocking → 422). Reason codes are the
// §8.2 machine-readable catalogue.
//
// GRAPH LANGUAGE (§8.3, contract-grade): levels 2+ are authored as graph
// traversal / pattern matching — id-set membership probes and a recursive CTE
// walk over the wasInformedBy edges. No relational JOINs on surrogate keys; on
// Phase 2 each check transcribes directly to Cypher (MATCH / variable-length
// path). The storage engine is the only thing that changes.
//
// ENUM POLICY: schema conformance checks STRUCTURE (required fields, types,
// ranges) but deliberately NOT enum membership — new enum values are additive
// patch-level changes (§9.1) and servers must not reject them. The one
// server-enforced value set is consent_scope (§4.6), handled in layer2-store.

import type { Activity, Claim, Layer2Record, Metric, Relation } from '@openarx/types';
import { parseRecordId } from '@openarx/types';
import { query } from '../db/pool.js';

// ── Result shapes ────────────────────────────────────────────────────────────

export type ValidateLevel = 'graph_consistency' | 'provenance' | 'all';

export interface ValidationIssue {
  /** §8.2 reason code, e.g. 'schema_invalid', 'graph_conflict:agent:x:relation:…' */
  code: string;
  message: string;
}

export interface ValidationResult {
  /** Blocking issues — submission MUST be rejected (422 at the MCP layer). */
  errors: ValidationIssue[];
  /** Non-blocking findings from opt-in levels (empty unless requested). */
  warnings: ValidationIssue[];
}

export interface ValidateOptions {
  validate?: ValidateLevel;
  /** Escalate opt-in warnings to blocking errors (§8.1). */
  strict?: boolean;
}

// ── Level 1: schema conformance (pure, blocking) ─────────────────────────────

type Issues = ValidationIssue[];

function issue(issues: Issues, message: string): void {
  issues.push({ code: 'schema_invalid', message });
}

function reqString(issues: Issues, v: unknown, path: string): void {
  if (typeof v !== 'string' || v.length === 0) issue(issues, `${path}: required non-empty string`);
}

function reqIso(issues: Issues, v: unknown, path: string): void {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) issue(issues, `${path}: required ISO-8601 timestamp`);
}

function reqUnit(issues: Issues, v: unknown, path: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) issue(issues, `${path}: required number in [0,1]`);
}

function reqStringArray(issues: Issues, v: unknown, path: string): void {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) issue(issues, `${path}: required string[]`);
}

function validateCycleContext(issues: Issues, v: unknown, path: string, required: boolean): void {
  if (v === undefined || v === null) {
    if (required) issue(issues, `${path}: required`);
    return;
  }
  const cc = v as Record<string, unknown>;
  reqString(issues, cc.cycle_type, `${path}.cycle_type`);
  reqString(issues, cc.run_id, `${path}.run_id`);
  reqString(issues, cc.stage_id, `${path}.stage_id`);
}

function validateClaimSchema(c: Claim): Issues {
  const issues: Issues = [];
  reqString(issues, c.attester_id, 'attester_id');
  reqIso(issues, c.attested_at, 'attested_at');
  if (typeof c.chain_complete !== 'boolean') issue(issues, 'chain_complete: required boolean');
  const ct = c.content as unknown as Record<string, unknown> | undefined;
  if (!ct || typeof ct !== 'object') issue(issues, 'content: required object');
  else {
    reqString(issues, ct.text, 'content.text');
    reqString(issues, ct.modality, 'content.modality');
    reqString(issues, ct.claim_type, 'content.claim_type');
    reqString(issues, ct.claim_status, 'content.claim_status');
    reqUnit(issues, ct.claim_strength, 'content.claim_strength');
    reqUnit(issues, ct.extraction_fidelity, 'content.extraction_fidelity');
  }
  if (!Array.isArray(c.evidence)) issue(issues, 'evidence: required array');
  else
    c.evidence.forEach((ev, i) => {
      const e = ev as unknown as Record<string, unknown>;
      reqString(issues, e.source_uri, `evidence[${i}].source_uri`);
      reqString(issues, e.excerpt, `evidence[${i}].excerpt`);
      reqString(issues, e.provenance, `evidence[${i}].provenance`);
      reqUnit(issues, e.similarity_score, `evidence[${i}].similarity_score`);
      reqIso(issues, e.retrieved_at, `evidence[${i}].retrieved_at`);
    });
  validateCycleContext(issues, c.cycle_context, 'cycle_context', false);
  if (c.authority_chain !== undefined) reqStringArray(issues, c.authority_chain, 'authority_chain');
  return issues;
}

/** edge_provenance.source values that ARE citation-derived (§7.6 P1) — a same_as
 * with one of these still requires citation_context; any other source (inference-
 * based) may omit it. */
const CITATION_BASED_EDGE_SOURCES = new Set(['explicit_citation', 'agent_annotation']);

function validateRelationSchema(r: Relation): Issues {
  const issues: Issues = [];
  reqString(issues, r.attester_id, 'attester_id');
  reqIso(issues, r.attested_at, 'attested_at');
  reqString(issues, r.source_claim_id, 'source_claim_id');
  reqString(issues, r.target_claim_id, 'target_claim_id');
  reqString(issues, r.relation, 'relation');
  if (r.relation === 'same_as') {
    // §7.6 P1: symmetric — direction is server-canonicalized (not client-required);
    // a claim cannot be same_as itself.
    if (r.source_claim_id && r.target_claim_id && r.source_claim_id === r.target_claim_id)
      issue(issues, 'same_as: source_claim_id and target_claim_id must differ (a claim is not same_as itself)');
  } else {
    reqString(issues, r.direction, 'direction');
  }
  const ep = r.edge_provenance as unknown as Record<string, unknown> | undefined;
  const epSource = ep && typeof ep === 'object' ? ep.source : undefined;
  // §7.6 P1 ratification (2026-07-05): citation_context is required for the six
  // directed relations and for a CITATION-based same_as (explicit_citation /
  // agent_annotation); it is OPTIONAL for an INFERENCE-based same_as
  // (semantic_similarity / llm_inference / platform_algorithmic / cross_agent_consensus)
  // — an algorithmic equivalence has no citing sentence, and synthesizing one would
  // fabricate provenance. When present it is always shape-checked.
  const citationRequired =
    r.relation !== 'same_as' || (typeof epSource === 'string' && CITATION_BASED_EDGE_SOURCES.has(epSource));
  const cc = r.citation_context as unknown as Record<string, unknown> | undefined;
  if (citationRequired && (!cc || typeof cc !== 'object')) {
    issue(issues, 'citation_context: required object (omit only for an inference-based same_as)');
  } else if (cc && typeof cc === 'object') {
    reqString(issues, cc.sentence, 'citation_context.sentence');
    reqString(issues, cc.preceding, 'citation_context.preceding');
    reqString(issues, cc.following, 'citation_context.following');
  }
  if (!ep || typeof ep !== 'object') issue(issues, 'edge_provenance: required object');
  else {
    reqString(issues, ep.source, 'edge_provenance.source');
    reqUnit(issues, ep.confidence, 'edge_provenance.confidence');
  }
  if (r.relation === 'shared_evidence') {
    reqString(issues, r.shared_source_uri, 'shared_source_uri (required for shared_evidence)');
    reqString(issues, r.interpretation_difference, 'interpretation_difference (required for shared_evidence)');
  }
  if (r.mediator !== undefined) {
    const m = r.mediator as unknown as Record<string, unknown>;
    reqString(issues, m.variable, 'mediator.variable');
    reqString(issues, m.condition, 'mediator.condition');
    reqString(issues, m.rationale, 'mediator.rationale');
  }
  return issues;
}

function validateActivitySchema(a: Activity): Issues {
  const issues: Issues = [];
  reqString(issues, a.attester_id, 'attester_id');
  reqIso(issues, a.attested_at, 'attested_at');
  reqString(issues, a.activity_type, 'activity_type');
  reqIso(issues, a.started_at, 'started_at');
  reqIso(issues, a.ended_at, 'ended_at');
  reqStringArray(issues, a.wasAssociatedWith, 'wasAssociatedWith');
  reqStringArray(issues, a.used, 'used');
  reqStringArray(issues, a.generated, 'generated');
  reqStringArray(issues, a.wasInformedBy, 'wasInformedBy');
  const ac = a.activity_content as unknown as Record<string, unknown> | undefined;
  if (!ac || typeof ac !== 'object') issue(issues, 'activity_content: required object');
  else {
    reqString(issues, ac.trigger, 'activity_content.trigger');
    validateCycleContext(issues, ac.cycle_context, 'activity_content.cycle_context', true);
  }
  // A3: optional hash-included classifiers — if present, must be a string.
  if (a.applied_instrument !== undefined && typeof a.applied_instrument !== 'string')
    issue(issues, 'applied_instrument: must be a string when present');
  if (a.genre !== undefined && typeof a.genre !== 'string')
    issue(issues, 'genre: must be a string when present');
  return issues;
}

function validateMetricSchema(m: Metric): Issues {
  const issues: Issues = [];
  reqString(issues, m.attester_id, 'attester_id');
  reqIso(issues, m.attested_at, 'attested_at');
  reqString(issues, m.metric_name, 'metric_name');
  if (typeof m.metric_value !== 'number' || !Number.isFinite(m.metric_value))
    issue(issues, 'metric_value: required finite number');
  reqString(issues, m.metric_type, 'metric_type');
  reqString(issues, m.computation, 'computation');
  reqString(issues, m.wasGeneratedBy, 'wasGeneratedBy');
  reqString(issues, m.measures_entity, 'measures_entity');
  validateCycleContext(issues, m.cycle_context, 'cycle_context', true);
  return issues;
}

function validateBundleSchema(b: Layer2Record & { manifest?: unknown }): Issues {
  const issues: Issues = [];
  reqString(issues, b.attester_id, 'attester_id');
  reqIso(issues, b.attested_at, 'attested_at');
  if (!b.manifest || typeof b.manifest !== 'object') issue(issues, 'manifest: required object (ro-crate-metadata.json)');
  return issues;
}

/** Level-1 schema conformance. Pure; blocking. */
export function validateRecordSchema(record: Layer2Record): Issues {
  switch (record.record_type) {
    case 'claim':
      return validateClaimSchema(record);
    case 'relation':
      return validateRelationSchema(record);
    case 'activity':
      return validateActivitySchema(record);
    case 'metric':
      return validateMetricSchema(record);
    case 'bundle':
      return validateBundleSchema(record);
    default:
      return [{ code: 'schema_invalid', message: `record_type: unknown '${(record as Layer2Record).record_type}'` }];
  }
}

/**
 * MENTEE-authored content-shape validation (wave-v2 checkpoint ingress, openarx-xpfz).
 * Validates ONLY the id-affecting fields a mentee authors at submit time — NOT the
 * server-stamped provenance (attester_id / attested_at / chain_complete / verification /
 * run_id / cycle_context), which the write-path adds AFTER resolve→validate. A flat claim
 * (no `content:{}`) is malformed here: its §4.3 hash-scope would degenerate to attester-only
 * and collapse (the claim-id-collapse bug). Reuses this module's field helpers (no drift);
 * the caller (methodist validate-schema primitive) throws bad-output on any issue.
 */
// §12.8 (c) relation ontology (contracts-ratified). CLOSED enums — relations enforce membership
// (unlike open claim enums, §8): EPISTEMIC = the §7 scientific relation types; ENGINEERING = the c8
// engineering seed. These sets are CLOSED-BY-VERSION, not a permanent hardcode: a new type is added
// via a COORDINATED methodology version bump (methodist proposes verb lower_snake under the contracts
// guardrail → registered → enum ↑ → enforced-set updated in lockstep). {depends_on,satisfies} is the
// current engineering version; never widen either set silently — a change here IS a version event.
const EPISTEMIC_RELATIONS = new Set(['support', 'extend', 'qualify', 'refute', 'background', 'shared_evidence', 'same_as']);
const ENGINEERING_RELATIONS = new Set(['depends_on', 'satisfies']);

export function validateRecordShape(record: unknown, recordType: string): ValidationIssue[] {
  const issues: Issues = [];
  const rec = (record ?? {}) as Record<string, unknown>;
  switch (recordType) {
    case 'claim': {
      const ct = rec.content as Record<string, unknown> | undefined;
      if (!ct || typeof ct !== 'object' || Array.isArray(ct)) {
        issue(issues, 'content: required object (claim payload must be content-wrapped, not flat)');
      } else {
        reqString(issues, ct.text, 'content.text');
        reqString(issues, ct.modality, 'content.modality');
        reqString(issues, ct.claim_type, 'content.claim_type');
        reqString(issues, ct.claim_status, 'content.claim_status');
        reqUnit(issues, ct.claim_strength, 'content.claim_strength');
        reqUnit(issues, ct.extraction_fidelity, 'content.extraction_fidelity');
      }
      if (!Array.isArray(rec.evidence)) issue(issues, 'evidence: required array');
      else
        (rec.evidence as unknown[]).forEach((ev, i) => {
          const e = (ev ?? {}) as Record<string, unknown>;
          reqString(issues, e.source_uri, `evidence[${i}].source_uri`);
          reqString(issues, e.excerpt, `evidence[${i}].excerpt`);
          reqString(issues, e.provenance, `evidence[${i}].provenance`);
          reqUnit(issues, e.similarity_score, `evidence[${i}].similarity_score`);
          reqIso(issues, e.retrieved_at, `evidence[${i}].retrieved_at`);
        });
      break;
    }
    case 'relation': {
      reqString(issues, rec.source_claim_id, 'source_claim_id');
      reqString(issues, rec.target_claim_id, 'target_claim_id');
      reqString(issues, rec.relation, 'relation');
      reqString(issues, rec.direction, 'direction'); // required for BOTH classes (§12.8 (c))
      // §12.8 (c) per-class enforcement. relation_class (top-level, default 'epistemic') selects the
      // enum + the required-set. engineering (dependency/satisfies) is first-class but NOT scientific
      // → its own closed enum, citation_context/edge_provenance OPTIONAL. epistemic (§7) keeps §7.6.
      const relationClass = typeof rec.relation_class === 'string' ? rec.relation_class : 'epistemic';
      if (rec.relation_class !== undefined && relationClass !== 'epistemic' && relationClass !== 'engineering') {
        issue(issues, "relation_class: must be 'epistemic' or 'engineering'");
      }
      const relValue = typeof rec.relation === 'string' ? rec.relation : '';
      if (relationClass === 'engineering') {
        if (relValue && !ENGINEERING_RELATIONS.has(relValue)) {
          issue(issues, `relation: '${relValue}' not in the engineering enum (${[...ENGINEERING_RELATIONS].join('|')})`);
        }
      } else {
        if (relValue && !EPISTEMIC_RELATIONS.has(relValue)) {
          issue(issues, `relation: '${relValue}' not in the §7 epistemic enum (${[...EPISTEMIC_RELATIONS].join('|')})`);
        }
        // citation_context required except for same_as (an equivalence may be inference-based, §7.6).
        if (relValue !== 'same_as' && (!rec.citation_context || typeof rec.citation_context !== 'object')) {
          issue(issues, 'citation_context: required object (epistemic §7.6; optional only for same_as)');
        }
        if (!rec.edge_provenance || typeof rec.edge_provenance !== 'object') {
          issue(issues, 'edge_provenance: required object (epistemic §7.6)');
        }
      }
      break;
    }
    case 'activity':
      reqString(issues, rec.activity_type, 'activity_type');
      break;
    case 'metric':
      reqString(issues, rec.metric_name, 'metric_name');
      reqString(issues, rec.metric_type, 'metric_type');
      break;
    default:
      issue(issues, `record_type: unknown '${recordType}'`);
  }
  return issues;
}

// ── Graph probes (shared by levels 2+) ───────────────────────────────────────

/**
 * Which of the given record ids exist in the graph? Ids are dispatched to their
 * node table by the record_type segment of the id itself (graph terms: node
 * lookup by identity, not a relational join). Malformed ids are reported absent.
 */
export async function existingRecordIds(ids: string[]): Promise<Set<string>> {
  const byType = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const parsed = parseRecordId(id);
    if (!parsed) continue;
    const arr = byType.get(parsed.recordType) ?? [];
    arr.push(id);
    byType.set(parsed.recordType, arr);
  }
  const found = new Set<string>();
  const table: Record<string, string> = {
    claim: 'layer2_claims',
    relation: 'layer2_relations',
    activity: 'layer2_activities',
    metric: 'layer2_metrics',
    bundle: 'layer2_bundles',
  };
  for (const [type, list] of byType) {
    const r = await query<{ id: string }>(`SELECT id FROM ${table[type]} WHERE id = ANY($1)`, [list]);
    for (const row of r.rows) found.add(row.id);
  }
  return found;
}

// ── Level 2: graph_consistency ───────────────────────────────────────────────

// Edge types that contradict each other between the same (source, target) pair.
const CONFLICTING_EDGES: Record<string, string[]> = {
  refute: ['support', 'background'],
  support: ['refute'],
  background: ['refute'],
};

async function checkGraphConsistency(record: Layer2Record): Promise<Issues> {
  const issues: Issues = [];
  const refs: string[] = [];
  if (record.supersedes) refs.push(record.supersedes);

  if (record.record_type === 'relation') {
    const r = record;
    refs.push(r.source_claim_id, r.target_claim_id);
    // Edge invariant (§8.1): qualify MUST carry a mediator.
    if (r.relation === 'qualify' && r.mediator === undefined) {
      issues.push({ code: 'graph_conflict:qualify_without_mediator', message: 'qualify relations must carry a mediator' });
    }
    // Conflicting parallel edge between the same claim pair (§8.2 graph_conflict).
    const conflictsWith = CONFLICTING_EDGES[r.relation as string];
    if (conflictsWith?.length) {
      const existing = await query<{ id: string; relation: string }>(
        `SELECT id, relation FROM layer2_relations
          WHERE source_claim_id = $1 AND target_claim_id = $2 AND relation = ANY($3)`,
        [r.source_claim_id, r.target_claim_id, conflictsWith],
      );
      for (const row of existing.rows) {
        issues.push({
          code: `graph_conflict:${row.id}`,
          message: `new '${r.relation}' edge conflicts with existing '${row.relation}' edge on the same claim pair`,
        });
      }
    }
  } else if (record.record_type === 'activity') {
    refs.push(...record.used, ...record.generated, ...record.wasInformedBy);
  } else if (record.record_type === 'metric') {
    refs.push(record.wasGeneratedBy, record.measures_entity);
  }

  // Node-existence probe for every referenced id.
  const layer2Refs = refs.filter((id) => parseRecordId(id) !== null);
  if (layer2Refs.length > 0) {
    const found = await existingRecordIds(layer2Refs);
    for (const id of new Set(layer2Refs)) {
      if (!found.has(id)) {
        issues.push({ code: `graph_conflict:${id}`, message: `referenced record does not exist: ${id}` });
      }
    }
  }
  return issues;
}

// ── Level 3: provenance ──────────────────────────────────────────────────────

/**
 * wasInformedBy chain completeness — recursive walk over activity edges.
 * Graph reading: start from the submitted record's wasInformedBy frontier and
 * follow was_informed_by edges transitively; every visited node must exist.
 * (Cypher equivalent: MATCH (a)-[:WAS_INFORMED_BY*]->(x) — all x resolvable.)
 */
async function missingInformedByChain(frontier: string[]): Promise<string[]> {
  if (frontier.length === 0) return [];
  const r = await query<{ missing_id: string }>(
    `WITH RECURSIVE walk (id) AS (
        SELECT DISTINCT unnest($1::text[])
      UNION
        SELECT DISTINCT unnest(a.was_informed_by)
          FROM layer2_activities a
          JOIN walk w ON a.id = w.id
     )
     SELECT w.id AS missing_id
       FROM walk w
       LEFT JOIN layer2_activities a ON a.id = w.id
      WHERE a.id IS NULL`,
    [frontier],
  );
  return r.rows.map((row) => row.missing_id);
}

async function checkProvenance(record: Layer2Record): Promise<Issues> {
  const issues: Issues = [];
  if (record.record_type === 'claim') {
    const c = record;
    // Initial CoE policy: an empirical_result asserted with a complete chain
    // must rest on at least one non-argument evidence entry; and a complete
    // chain cannot be empty. Conservative starting rules — additive to extend.
    if (c.chain_complete && c.evidence.length === 0) {
      issues.push({ code: 'provenance_incomplete', message: 'chain_complete=true but evidence[] is empty' });
    }
    if (c.content.claim_status === 'empirical_result' && c.evidence.length > 0) {
      const nonArgument = c.evidence.some((e) => e.provenance !== 'argument_only');
      if (!nonArgument) {
        issues.push({
          code: 'provenance_incomplete',
          message: "claim_status='empirical_result' backed only by argument_only evidence",
        });
      }
    }
  } else if (record.record_type === 'activity') {
    const missing = await missingInformedByChain(record.wasInformedBy);
    for (const id of missing) {
      issues.push({ code: 'provenance_incomplete', message: `wasInformedBy chain incomplete: ${id} not found` });
    }
  }
  return issues;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run ingress validation per §8.1. Schema conformance always runs and blocks;
 * opt-in levels populate warnings (or errors when strict=true). Id uniqueness
 * is enforced downstream by the store (§8.4 idempotency / IdCollisionError).
 */
export async function runIngressValidation(
  record: Layer2Record,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const errors: ValidationIssue[] = validateRecordSchema(record);
  const warnings: ValidationIssue[] = [];
  // Opt-in levels only make sense on a structurally valid record.
  if (errors.length === 0 && opts.validate) {
    const wantGraph = opts.validate === 'graph_consistency' || opts.validate === 'all';
    const wantProv = opts.validate === 'provenance' || opts.validate === 'all';
    if (wantGraph) warnings.push(...(await checkGraphConsistency(record)));
    if (wantProv) warnings.push(...(await checkProvenance(record)));
  }
  if (opts.strict && warnings.length > 0) {
    errors.push(...warnings.splice(0, warnings.length));
  }
  return { errors, warnings };
}
