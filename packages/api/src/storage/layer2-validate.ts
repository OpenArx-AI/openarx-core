// ── Layer 2 — ingress record-shape validation (§8 / §12.8) ───────────────────
//
// validateRecordShape is the pure, blocking shape-check the methodist runs on a
// mentee's submitted records at commit — the id-affecting fields the author writes
// (NOT the server-stamped provenance the write-path adds later). It is the ONLY
// validation surface that remains here: the old PG-facade ingress subsystem
// (runIngressValidation + the full schema / graph-consistency / provenance validators
// that queried the layer2_* tables) was removed with the PG→Neo4j teardown
// (openarx-1woy / openarx-contracts-9xgj) — those tables are dropped and Neo4j is the
// canonical graph.
//
// ENUM POLICY: shape checks STRUCTURE (required fields, types, ranges), NOT open enum
// membership — new enum values are additive patch-level changes (§9.1) and servers must
// not reject them. The one enforced set is the §12.8 (c) relation ontology below.

// ── Result shape ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  /** §8.2 reason code, e.g. 'schema_invalid'. */
  code: string;
  message: string;
}

type Issues = ValidationIssue[];

function issue(issues: Issues, message: string): void {
  issues.push({ code: 'schema_invalid', message });
}

function reqString(issues: Issues, v: unknown, path: string): void {
  if (typeof v !== 'string' || v.length === 0) issue(issues, `${path}: required non-empty string`);
}

function reqIso(issues: Issues, v: unknown, path: string): void {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)))
    issue(issues, `${path}: required ISO-8601 timestamp`);
}

function reqUnit(issues: Issues, v: unknown, path: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
    issue(issues, `${path}: required number in [0,1]`);
}

// §12.8 (c) relation ontology (contracts-ratified). CLOSED enums — relations enforce membership
// (unlike open claim enums, §8): EPISTEMIC = the §7 scientific relation types; ENGINEERING = the c8
// engineering seed. These sets are CLOSED-BY-VERSION, not a permanent hardcode: a new type is added
// via a COORDINATED methodology version bump (methodist proposes verb lower_snake under the contracts
// guardrail → registered → enum ↑ → enforced-set updated in lockstep). {depends_on,satisfies} is the
// current engineering version; never widen either set silently — a change here IS a version event.
const EPISTEMIC_RELATIONS = new Set([
  'support',
  'extend',
  'qualify',
  'refute',
  'background',
  'shared_evidence',
  'same_as',
]);
const ENGINEERING_RELATIONS = new Set(['depends_on', 'satisfies']);

// §12.1 bundle kinds (openarx-1ed5) — a CLOSED discriminator enum (like relation_class): it selects
// the required-field set, so an unknown value cannot be shape-checked. Extensible BY-VERSION.
const BUNDLE_TYPES = new Set(['ro_crate', 'narrative_synthesis']);

// §12.4 (openarx-0aof): the CLOSED set of activity_types a WARD may submit as an authoritative
// record. Currently {version_closeout} — run-closure is the only ward-authored activity; all other
// activity intents have proper homes (claims / relations / bundle). System- and methodist-emitted
// outcome activities (§12.4 co-sign/tier-change/course-completion/contested-attestation) and the
// checkpoint_go/return path do NOT pass through this ward shape-check. This deterministic guard
// replaces the LLM checkpoint-judge's fragile P-6 extrapolation (grading reproducibility).
// Extensible BY-VERSION (e.g. a future c9 review-attestation type, openarx-t6ou).
const WARD_SUBMITTABLE_ACTIVITY_TYPES = new Set(['version_closeout']);

/**
 * Validate a mentee-submitted record's SHAPE — the id-affecting fields authored at submit
 * time, NOT the server-stamped provenance (attester_id / attested_at / run_id / cycle_context)
 * the write-path adds AFTER resolve→validate. A flat claim (no `content:{}`) is malformed here:
 * its §4.3 hash-scope would degenerate to attester-only and collapse (the claim-id-collapse bug).
 * The caller (methodist validate-schema primitive) throws bad-output on any issue.
 */
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
      const relationClass =
        typeof rec.relation_class === 'string' ? rec.relation_class : 'epistemic';
      if (
        rec.relation_class !== undefined &&
        relationClass !== 'epistemic' &&
        relationClass !== 'engineering'
      ) {
        issue(issues, "relation_class: must be 'epistemic' or 'engineering'");
      }
      const relValue = typeof rec.relation === 'string' ? rec.relation : '';
      if (relationClass === 'engineering') {
        if (relValue && !ENGINEERING_RELATIONS.has(relValue)) {
          issue(
            issues,
            `relation: '${relValue}' not in the engineering enum (${[...ENGINEERING_RELATIONS].join('|')})`,
          );
        }
      } else {
        if (relValue && !EPISTEMIC_RELATIONS.has(relValue)) {
          issue(
            issues,
            `relation: '${relValue}' not in the §7 epistemic enum (${[...EPISTEMIC_RELATIONS].join('|')})`,
          );
        }
        // citation_context required as a STRING except for same_as. §4.3-frozen: citation_context is
        // IN the relation hash-scope, so its TYPE is identity-critical — the methodology and the live
        // edges use a flat string (contracts §7.6 ruling 2026-07-13; requiring an object would recompute
        // every relation id and break existing edges + dedup). same_as may be inference-based (no citation).
        if (
          relValue !== 'same_as' &&
          (typeof rec.citation_context !== 'string' || rec.citation_context.trim() === '')
        ) {
          issue(
            issues,
            'citation_context: required string (epistemic §7.6; optional only for same_as)',
          );
        }
        // edge_provenance is OPTIONAL on ingress — absent from record_schemas and OUTSIDE the §4.3
        // hash-scope (contracts §7.6 ruling 2026-07-13; the old PG-model "mandatory" is superseded).
        // It stays as free _data if the mentee supplies it; no ingress requirement.
      }
      break;
    }
    case 'activity': {
      reqString(issues, rec.activity_type, 'activity_type');
      // §12.4 (openarx-0aof): deterministic ward-submission guard — a ward may author ONLY a
      // {version_closeout} activity. Any other activity_type has a proper home in claims/relations/
      // bundle; rejecting it here (not via an LLM judge) makes grading reproducible.
      const at = typeof rec.activity_type === 'string' ? rec.activity_type : '';
      if (at && !WARD_SUBMITTABLE_ACTIVITY_TYPES.has(at)) {
        issue(
          issues,
          `activity_type: '${at}' is not ward-submittable — only {${[...WARD_SUBMITTABLE_ACTIVITY_TYPES].join('|')}} (§12.4; other intents belong in claims/relations/bundle)`,
        );
      }
      break;
    }
    case 'metric':
      reqString(issues, rec.metric_name, 'metric_name');
      reqString(issues, rec.metric_type, 'metric_type');
      break;
    case 'bundle': {
      // §12.1 bundle (openarx-1ed5). bundle_type discriminates kind (CLOSED enum, like relation_class:
      // it selects the required-field set → an unknown value cannot be validated).
      const bt = typeof rec.bundle_type === 'string' ? rec.bundle_type : '';
      if (!BUNDLE_TYPES.has(bt)) {
        issue(issues, `bundle_type: required, one of {${[...BUNDLE_TYPES].join('|')}}`);
      }
      if (bt === 'narrative_synthesis') {
        // synthesis-BY-REFERENCE: members = EXISTING canonical claim_ids, REFERENCED not re-minted.
        if (!Array.isArray(rec.members) || rec.members.length === 0) {
          issue(issues, 'members: required non-empty array of existing claim_ids (narrative_synthesis)');
        } else {
          (rec.members as unknown[]).forEach((m, i) => reqString(issues, m, `members[${i}]`));
        }
        // the narrative deliverable is committed on the bundle (hash-EXCLUDED projection, §4.3 0043).
        reqString(issues, rec.synthesis_narrative, 'synthesis_narrative');
      } else if (bt === 'ro_crate') {
        if (!rec.manifest || typeof rec.manifest !== 'object' || Array.isArray(rec.manifest)) {
          issue(issues, 'manifest: required object (ro_crate)');
        }
      }
      break;
    }
    default:
      issue(issues, `record_type: unknown '${recordType}'`);
  }
  return issues;
}
