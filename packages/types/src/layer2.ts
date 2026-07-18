// ── Layer 2 — Claims & Relations Pillar (record shapes) ──────────────────────
//
// Contract: openarx-contracts/contracts/layer_2_pillar.md (+ MASTER_CONTRACT §11).
// Methodological source-of-truth for field semantics:
//   openarx-promo/docs/idearank/layer_2_specification_v0_1.md v0.5.
//
// Phase-1 storage is graph-friendly Postgres (5 tables), Phase-2 target is Neo4j.
// These types are shared across Core storage (@openarx/api), the MCP profile
// (@openarx/mcp), and the future client SDK — one source of truth for the shapes.
//
// READ-SIDE INVARIANT (§9.3): every enum field MUST tolerate unknown values —
// unknown strings are preserved opaquely, never rejected. We model every enum as
// `KnownUnion | (string & {})` so known values keep autocomplete while any string
// round-trips losslessly. KNOWN_* arrays back the conformance test (§9.4).

// ── Enums (known values; unknown-tolerant at the type level) ─────────────────

export const KNOWN_MODALITIES = ['empirical', 'theoretical', 'descriptive', 'normative'] as const;
export type Modality = (typeof KNOWN_MODALITIES)[number] | (string & {});

export const KNOWN_CLAIM_TYPES = ['measurement', 'inference', 'analogy', 'citation'] as const;
export type ClaimType = (typeof KNOWN_CLAIM_TYPES)[number] | (string & {});

export const KNOWN_CLAIM_STATUSES = [
  'empirical_result',
  'theorem',
  'formal_argument',
  'conjecture',
  'survey_assertion',
  'open_question',
] as const;
export type ClaimStatus = (typeof KNOWN_CLAIM_STATUSES)[number] | (string & {});

export const KNOWN_EVIDENCE_PROVENANCE = [
  'own_experiment',
  'cited_external',
  'replicated_external',
  'argument_only',
] as const;
export type EvidenceProvenance = (typeof KNOWN_EVIDENCE_PROVENANCE)[number] | (string & {});

export const KNOWN_VERIFICATION_OUTCOMES = ['VERIFIED', 'REJECTED', 'UNVERIFIABLE'] as const;
export type VerificationOutcome = (typeof KNOWN_VERIFICATION_OUTCOMES)[number] | (string & {});

export const KNOWN_VERIFICATION_METHODS = ['single_model', 'cross_family'] as const;
export type VerificationMethod = (typeof KNOWN_VERIFICATION_METHODS)[number] | (string & {});

export const KNOWN_RELATIONS = [
  'support',
  'extend',
  'qualify',
  'refute',
  'background',
  'shared_evidence',
  'same_as', // A1/P1 (final wave 2026-07-05, §7.6): the ONLY symmetric relation — convergent-pair equivalence
] as const;
export type RelationType = (typeof KNOWN_RELATIONS)[number] | (string & {});

/**
 * Sentinel stored in the (NOT NULL) `direction` column for symmetric `same_as`
 * relations. `direction` is excluded from a `same_as` record's content_hash
 * (§7.6 P1), so this value is storage bookkeeping only — never part of the id.
 */
export const SAME_AS_DIRECTION = 'symmetric';

export const KNOWN_DIRECTIONS = ['citing_to_cited'] as const;
export type Direction = (typeof KNOWN_DIRECTIONS)[number] | (string & {});

export const KNOWN_EDGE_PROVENANCE_SOURCES = [
  'explicit_citation',
  'semantic_similarity',
  'llm_inference',
  'agent_annotation',
  'cross_agent_consensus',
  'platform_algorithmic',
] as const;
export type EdgeProvenanceSource = (typeof KNOWN_EDGE_PROVENANCE_SOURCES)[number] | (string & {});

export const KNOWN_ACTIVITY_TYPES = [
  'cycle_run',
  'stage_transition',
  'mcp_call',
  'decision',
  'verification',
  'delegation',
  'warning_bell_trigger',
] as const;
export type ActivityType = (typeof KNOWN_ACTIVITY_TYPES)[number] | (string & {});

export const KNOWN_METRIC_TYPES = ['float', 'int', 'ratio', 'distribution'] as const;
export type MetricType = (typeof KNOWN_METRIC_TYPES)[number] | (string & {});

// consent_scope: three-value enum retained as a reserved schema position; Phase 1
// servers accept ONLY 'public_read' (§4.6). Field is hash-EXCLUDED.
export const KNOWN_CONSENT_SCOPES = ['internal', 'platform_wide', 'public_read'] as const;
export type ConsentScope = (typeof KNOWN_CONSENT_SCOPES)[number] | (string & {});

export const RECORD_TYPES = ['claim', 'relation', 'activity', 'metric', 'bundle'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

// ── Identifier ───────────────────────────────────────────────────────────────
// id = {source_prefix}:{record_type}:{content_hash}
//   source_prefix ∈ { agent:{agent_id}, platform:algorithm:{name}, human:{portal_user_id} }
//     — MAY itself contain ':' (e.g. `agent:msi:openarx-research`).
//   content_hash  = SHA-256 hex of the JCS-canonical hash-scope (§4.3).

/** Build a record id. `sourcePrefix` may contain ':'; `contentHash` must not. */
export function buildRecordId(sourcePrefix: string, recordType: RecordType, contentHash: string): string {
  return `${sourcePrefix}:${recordType}:${contentHash}`;
}

export interface ParsedRecordId {
  sourcePrefix: string;
  recordType: RecordType;
  contentHash: string;
}

/**
 * Parse a record id. Robust to ':' inside source_prefix: content_hash is the
 * last segment, record_type the second-to-last, source_prefix everything before.
 * Returns null if the shape is not `<prefix>:<known-record-type>:<hex-hash>`.
 */
export function parseRecordId(id: string): ParsedRecordId | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  const contentHash = parts[parts.length - 1]!;
  const recordType = parts[parts.length - 2]!;
  const sourcePrefix = parts.slice(0, parts.length - 2).join(':');
  if (!sourcePrefix) return null;
  if (!(RECORD_TYPES as readonly string[]).includes(recordType)) return null;
  if (!/^[0-9a-f]{64}$/i.test(contentHash)) return null;
  return { sourcePrefix, recordType: recordType as RecordType, contentHash };
}

// ── Shared sub-structures ────────────────────────────────────────────────────

/** cycle_context — methodology-run coordinates. Hash-INCLUDED where it appears. */
export interface CycleContext {
  cycle_type: string; // '1'..'6' (spec); kept string for unknown-tolerance
  run_id: string;
  stage_id: string; // metric records constrain this to 'final' | 'intermediate'
}

/** Post-submission verification result. Hash-EXCLUDED (may be updated later). */
export interface Verification {
  outcome: VerificationOutcome;
  verifier_id: string;
  verifier_family: string; // 'claude' | 'gpt' | 'gemini' | … (extensible)
  verified_at: string; // ISO-8601 UTC
  audit_replayable: boolean;
  verification_method: VerificationMethod; // Phase 1 always 'single_model' (§10)
  verification_caveat?: string;
  /** F-10 (openarx-contracts-ykdt): diagnosable reason for non-VERIFIED
   *  outcomes. Known: source_unresolvable | excerpt_mismatch |
   *  entailment_partial. Open set (§9.3); absent on VERIFIED. */
  reason_category?: string;
}

// ── CLAIM ────────────────────────────────────────────────────────────────────

export interface ClaimContent {
  text: string;
  modality: Modality;
  claim_type: ClaimType;
  claim_strength: number; // 0..1
  extraction_fidelity: number; // 0..1
  claim_status: ClaimStatus;
  stated_scope_caveats?: string;
}

export interface ClaimEvidence {
  source_uri: string; // e.g. 'arxiv:2401.12345'
  excerpt: string;
  similarity_score: number; // 0..1
  provenance: EvidenceProvenance;
  retrieved_at: string; // ISO-8601 UTC
  value_unit_method_uncertainty?: string;
  step_type?: string;
}

export interface Claim {
  id: string;
  record_type: 'claim';
  attester_id: string;
  attested_at: string; // ISO-8601 UTC
  content: ClaimContent;
  evidence: ClaimEvidence[];
  chain_complete: boolean;
  source_digest: string; // SHA-256 of content+evidence (tamper-evidence; ≠ content_hash)
  // hash-excluded / optional:
  cycle_context?: CycleContext; // hash-INCLUDED when present
  authority_chain?: string[]; // hash-INCLUDED when present (delegation chain)
  consent_scope?: ConsentScope; // hash-excluded; server-enforced 'public_read'
  verification?: Verification; // hash-excluded
  supersedes?: string | null; // hash-excluded
}

// ── RELATION ─────────────────────────────────────────────────────────────────

export interface RelationCitationContext {
  sentence: string;
  preceding: string;
  following: string;
}

/** Required for `qualify` relations (§8.1 graph invariant). Hash-INCLUDED. */
export interface RelationMediator {
  variable: string;
  condition: string;
  rationale: string;
}

/** Hash-EXCLUDED (may be refined by platform background processes). */
export interface EdgeProvenance {
  source: EdgeProvenanceSource;
  confidence: number; // 0..1
  evidence_chunk_id?: string;
}

export interface Relation {
  id: string;
  record_type: 'relation';
  attester_id: string;
  attested_at: string;
  source_claim_id: string; // plain string ref (never embedded)
  target_claim_id: string; // plain string ref
  relation: RelationType;
  direction: Direction; // symmetric for 'same_as' (SAME_AS_DIRECTION) — excluded from its hash (§7.6 P1)
  // Required for the six directed relations and citation-based same_as; OPTIONAL for
  // an inference-based same_as (§7.6 P1 ratification) — hash-INCLUDED when present.
  citation_context?: RelationCitationContext;
  edge_provenance: EdgeProvenance; // hash-excluded
  // optional:
  mediator?: RelationMediator; // hash-INCLUDED when present; required for 'qualify'; N/A for 'same_as' (symmetric)
  shared_source_uri?: string; // hash-INCLUDED when relation === 'shared_evidence'
  interpretation_difference?: string; // hash-INCLUDED when relation === 'shared_evidence'
  consent_scope?: ConsentScope; // hash-excluded
  supersedes?: string | null; // hash-excluded
}

// ── ACTIVITY (PROV-O) ────────────────────────────────────────────────────────

export interface ActivityContent {
  trigger: string;
  cycle_context: CycleContext;
  evidence?: string;
  decision?: string;
  rationale?: string;
}

export interface Activity {
  id: string;
  record_type: 'activity';
  attester_id: string;
  attested_at: string;
  activity_type: ActivityType;
  started_at: string;
  ended_at: string;
  wasAssociatedWith: string[]; // prov:Agent ids
  used: string[]; // prov:Entity ids
  generated: string[]; // prov:Entity ids (inverse of wasGeneratedBy)
  wasInformedBy: string[]; // preceding activity ids
  activity_content: ActivityContent;
  // optional (A3, final wave 2026-07-05 — hash-INCLUDED when present, §5):
  /** Which MCP tool / methodology instrument drove the activity (e.g. `methodist_checkpoint`). */
  applied_instrument?: string;
  /** Methodological genre / task-class of the activity (e.g. a review or maintenance genre). */
  genre?: string;
  // optional:
  consent_scope?: ConsentScope; // hash-excluded
  supersedes?: string | null; // hash-excluded
}

// ── METRIC ───────────────────────────────────────────────────────────────────

export interface Metric {
  id: string;
  record_type: 'metric';
  attester_id: string;
  attested_at: string;
  metric_name: string; // enum-ish, extensible (PCov, PSnd, …)
  metric_value: number;
  metric_type: MetricType;
  computation: string; // formula / procedure (reproducibility)
  wasGeneratedBy: string; // activity id
  measures_entity: string; // target entity id
  cycle_context: CycleContext; // stage_id ∈ {'final','intermediate'}
  // optional:
  consent_scope?: ConsentScope; // hash-excluded
  supersedes?: string | null; // hash-excluded
}

// ── BUNDLE (RO-Crate) ────────────────────────────────────────────────────────

export interface Bundle {
  id: string;
  record_type: 'bundle';
  /** Discriminates bundle kinds (§4.3 identity). 'ro_crate' = RO-Crate metadata bundle
   *  (carries `manifest`); 'narrative_synthesis' = c3-St5 synthesis-by-reference
   *  (carries `members` + `synthesis_narrative`). Hash-INCLUDED. All bundles set it. */
  bundle_type?: 'ro_crate' | 'narrative_synthesis';
  attester_id: string;
  attested_at: string;
  /** The full `ro-crate-metadata.json` manifest. Hash-INCLUDED (present-only).
   *  RO-Crate bundles only; absent on narrative_synthesis. */
  manifest?: Record<string, unknown>;
  /** narrative_synthesis: EXISTING canonical claim_ids being synthesized —
   *  referenced by id, NEVER re-minted (§12.1 bundle-by-reference, openarx-1ed5).
   *  Hash-INCLUDED as a SORTED SET (canonical member order → order-independent identity). */
  members?: string[];
  /** narrative_synthesis: the committed narrative-synthesis deliverable text.
   *  Hash-EXCLUDED (projection): editing it does NOT change the bundle-id — stored as a
   *  mutable-in-place projection (owner-only update, light edit-log; §4.3 ruling 0043). */
  synthesis_narrative?: string;
  // optional:
  consent_scope?: ConsentScope; // hash-excluded
  supersedes?: string | null; // hash-excluded
}

export type Layer2Record = Claim | Relation | Activity | Metric | Bundle;

// ── Hash scope (§4.3) ────────────────────────────────────────────────────────
//
// Top-level fields entering content_hash, per record type. Consumed by the M0
// content_hash module. Conservative default (§4.3): any field NOT listed here as
// excluded is included — so a new field surfaces as a mismatched id (visible),
// never a silent collision.
//
// NOTE: relation adds `mediator` / `shared_source_uri` / `interpretation_difference`
// CONDITIONALLY (present-only / shared_evidence-only) — the content_hash module
// applies the "absent fields are omitted" rule (§4.3), which handles the condition
// naturally once absent fields are stripped before canonicalization.

export const HASH_INCLUDED_FIELDS: Record<RecordType, readonly string[]> = {
  claim: ['content', 'evidence', 'attester_id', 'attested_at', 'cycle_context', 'authority_chain'],
  relation: [
    'source_claim_id',
    'target_claim_id',
    'relation',
    'direction',
    'citation_context',
    'mediator',
    'shared_source_uri',
    'interpretation_difference',
    'attester_id',
    'attested_at',
  ],
  activity: [
    'activity_type',
    'started_at',
    'ended_at',
    'wasAssociatedWith',
    'used',
    'generated',
    'wasInformedBy',
    'activity_content',
    'applied_instrument', // A3: hash-included when present (absent → omitted per §4.3, existing hashes unchanged)
    'genre', // A3: hash-included when present
    'attester_id',
    'attested_at',
  ],
  metric: [
    'metric_name',
    'metric_value',
    'metric_type',
    'computation',
    'wasGeneratedBy',
    'measures_entity',
    'cycle_context',
    'attester_id',
    'attested_at',
  ],
  // §4.3 bundle identity (openarx-1ed5): bundle_type discriminates kind; members = the
  // referenced claim_id SET (hashed sorted → order-independent, see extractHashScope);
  // manifest present-only (RO-Crate). synthesis_narrative is EXCLUDED (projection, mutable).
  bundle: ['bundle_type', 'members', 'manifest', 'attester_id', 'attested_at'],
} as const;

// Fields never entering the hash, for any record type (§4.3 hash-excluded list).
export const HASH_EXCLUDED_FIELDS = [
  'id',
  'record_type',
  'verification',
  'supersedes',
  'consent_scope',
  'edge_provenance',
  'source_digest',
] as const;
