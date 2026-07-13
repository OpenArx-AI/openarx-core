// ── FROZEN golden vectors — ported from packages/types/src/layer2-hash.test.ts ─
//
// These are DATA (not code) copied verbatim so the lab's canonicalize/compute-hash
// primitives reproduce the platform byte-for-byte WITHOUT importing @openarx.
// Any change here means the canonicalization scheme changed — catastrophic-
// breaking (§9.2). Keep in sync with the platform golden vectors.

import type { HashScope } from '../../src/index.js';

type Rec = Record<string, unknown>;

// ── hash-scope specs (ported HASH_INCLUDED_FIELDS + conditional rules) ─────────
export const CLAIM_SCOPE: HashScope = {
  include: ['content', 'evidence', 'attester_id', 'attested_at', 'cycle_context', 'authority_chain'],
};

export const RELATION_SCOPE: HashScope = {
  include: [
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
  keepOnlyWhen: [
    { fields: ['shared_source_uri', 'interpretation_difference'], when: { field: 'relation', equals: 'shared_evidence' } },
  ],
  dropWhen: [{ fields: ['direction', 'mediator'], when: { field: 'relation', equals: 'same_as' } }],
};

export const ACTIVITY_SCOPE: HashScope = {
  include: [
    'activity_type',
    'started_at',
    'ended_at',
    'wasAssociatedWith',
    'used',
    'generated',
    'wasInformedBy',
    'activity_content',
    'applied_instrument',
    'genre',
    'attester_id',
    'attested_at',
  ],
};

// ── records + expected bytes/hashes ───────────────────────────────────────────
export const CLAIM: Rec = {
  id: 'PLACEHOLDER',
  record_type: 'claim',
  attester_id: 'agent:msi:openarx-research',
  attested_at: '2026-07-01T12:00:00Z',
  content: {
    text: 'Method X improves accuracy by 3.2 points.',
    modality: 'empirical',
    claim_type: 'measurement',
    claim_strength: 0.85,
    extraction_fidelity: 0.9,
    claim_status: 'empirical_result',
  },
  evidence: [
    {
      source_uri: 'arxiv:2401.12345',
      excerpt: 'we observe a 3.2 point gain',
      similarity_score: 0.97,
      provenance: 'own_experiment',
      retrieved_at: '2026-07-01T11:00:00Z',
    },
  ],
  chain_complete: true,
  source_digest: 'PLACEHOLDER',
  cycle_context: { cycle_type: '3', run_id: 'run-abc', stage_id: 'final' },
  consent_scope: 'public_read',
  supersedes: null,
  verification: {
    outcome: 'VERIFIED',
    verifier_id: 'x',
    verifier_family: 'claude',
    verified_at: '2026-07-01T13:00:00Z',
    audit_replayable: true,
    verification_method: 'single_model',
  },
};

export const CLAIM_BYTES =
  '{"attested_at":"2026-07-01T12:00:00Z","attester_id":"agent:msi:openarx-research","content":{"claim_status":"empirical_result","claim_strength":0.85,"claim_type":"measurement","extraction_fidelity":0.9,"modality":"empirical","text":"Method X improves accuracy by 3.2 points."},"cycle_context":{"cycle_type":"3","run_id":"run-abc","stage_id":"final"},"evidence":[{"excerpt":"we observe a 3.2 point gain","provenance":"own_experiment","retrieved_at":"2026-07-01T11:00:00Z","similarity_score":0.97,"source_uri":"arxiv:2401.12345"}]}';
export const CLAIM_HASH = '591d46076be61196e4ce3bc660828816d1cfb00ebf03a0247b4887ed31f832c6';

export const REL_SHARED: Rec = {
  id: 'P',
  record_type: 'relation',
  attester_id: 'agent:a',
  attested_at: '2026-07-01T12:00:00Z',
  source_claim_id: `agent:x:claim:${'a'.repeat(64)}`,
  target_claim_id: `agent:y:claim:${'c'.repeat(64)}`,
  relation: 'shared_evidence',
  direction: 'citing_to_cited',
  citation_context: { sentence: 's', preceding: 'p', following: 'f' },
  edge_provenance: { source: 'explicit_citation', confidence: 0.9 },
  shared_source_uri: 'arxiv:2401.00001',
  interpretation_difference: 'A vs B',
};
export const RELSHARED_HASH = 'a7d506b9c01b5e4a66221bf33afdd677cd938c2444659ac0284650736f45f6a5';

export const ACTIVITY: Rec = {
  id: 'PLACEHOLDER',
  record_type: 'activity',
  attester_id: 'agent:a',
  attested_at: '2026-07-01T12:00:00Z',
  activity_type: 'stage_transition',
  started_at: '2026-07-01T11:00:00Z',
  ended_at: '2026-07-01T11:05:00Z',
  wasAssociatedWith: ['agent:a'],
  used: [],
  generated: [],
  wasInformedBy: [],
  activity_content: { trigger: 't', cycle_context: { cycle_type: '3', run_id: 'run-x', stage_id: 'final' } },
};
