import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContentHash,
  recordCanonicalBytes,
  computeSourceDigest,
  assignRecordId,
} from './layer2-hash.js';
import type { Activity, Bundle, Claim, Relation } from './layer2.js';

// ── Golden vectors (FROZEN) ──────────────────────────────────────────────────
// Pure RFC 8785 JCS, no NFC (contract §4.3 rev6). Any change to these constants
// means the canonicalization scheme changed — a catastrophic breaking change
// (§9.2) shifting every record id. Independent client implementations
// (Python/Go/Rust RFC 8785 libs) MUST reproduce these exact bytes and hashes.

const CLAIM: Claim = {
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

const CLAIM_BYTES =
  '{"attested_at":"2026-07-01T12:00:00Z","attester_id":"agent:msi:openarx-research","content":{"claim_status":"empirical_result","claim_strength":0.85,"claim_type":"measurement","extraction_fidelity":0.9,"modality":"empirical","text":"Method X improves accuracy by 3.2 points."},"cycle_context":{"cycle_type":"3","run_id":"run-abc","stage_id":"final"},"evidence":[{"excerpt":"we observe a 3.2 point gain","provenance":"own_experiment","retrieved_at":"2026-07-01T11:00:00Z","similarity_score":0.97,"source_uri":"arxiv:2401.12345"}]}';
const CLAIM_HASH = '591d46076be61196e4ce3bc660828816d1cfb00ebf03a0247b4887ed31f832c6';
const CLAIM_SRCDIGEST = 'ad51505560d8b5f54fe50616b25493129fc0d6d0eb2d04757ebb228ac2d7c1b9';
const RELSHARED_HASH = 'a7d506b9c01b5e4a66221bf33afdd677cd938c2444659ac0284650736f45f6a5';

test('claim — canonical bytes match the frozen golden vector', () => {
  assert.equal(recordCanonicalBytes(CLAIM), CLAIM_BYTES);
});

test('claim — content_hash matches golden + id assembles', () => {
  assert.equal(computeContentHash(CLAIM), CLAIM_HASH);
  assert.equal(
    assignRecordId(CLAIM, 'agent:msi:openarx-research').id,
    `agent:msi:openarx-research:claim:${CLAIM_HASH}`,
  );
});

test('claim — hash-excluded fields do NOT affect content_hash (§4.3)', () => {
  const flipped: Claim = {
    ...CLAIM,
    consent_scope: 'public_read',
    supersedes: `agent:x:claim:${'b'.repeat(64)}`,
    verification: undefined,
  };
  assert.equal(computeContentHash(flipped), CLAIM_HASH);
});

test('claim — source_digest (content+evidence) matches golden, distinct from content_hash', () => {
  assert.equal(computeSourceDigest(CLAIM), CLAIM_SRCDIGEST);
  assert.notEqual(CLAIM_SRCDIGEST, CLAIM_HASH);
});

const REL_SHARED: Relation = {
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

test('relation shared_evidence — includes shared_* fields, matches golden', () => {
  const bytes = recordCanonicalBytes(REL_SHARED);
  assert.ok(bytes.includes('shared_source_uri'));
  assert.ok(bytes.includes('interpretation_difference'));
  assert.ok(!bytes.includes('edge_provenance')); // hash-excluded
  assert.equal(computeContentHash(REL_SHARED), RELSHARED_HASH);
});

test('relation non-shared — stray shared_* fields are EXCLUDED from the hash', () => {
  const relSupport: Relation = {
    ...REL_SHARED,
    relation: 'support',
    shared_source_uri: 'arxiv:9999',
    interpretation_difference: 'ignored',
  };
  const bytes = recordCanonicalBytes(relSupport);
  assert.ok(!bytes.includes('shared_source_uri'));
  assert.ok(!bytes.includes('interpretation_difference'));
  // and differs from the shared_evidence hash
  assert.notEqual(computeContentHash(relSupport), RELSHARED_HASH);
});

// ── A1/P1 (final wave 2026-07-05): same_as symmetric relation ─────────────────
// direction & mediator are NOT part of a same_as record's identity (§7.6 P1).
// Endpoint-order canonicalization (source<target → mirror-dedup) is the STORE's
// job (canonicalizeSameAs); the hash module stays order-sensitive by design.

test('relation same_as — direction & mediator EXCLUDED from the hash (symmetric)', () => {
  const base: Relation = {
    ...REL_SHARED,
    relation: 'same_as',
    direction: 'symmetric',
    shared_source_uri: undefined,
    interpretation_difference: undefined,
  };
  const bytes = recordCanonicalBytes(base);
  assert.ok(!bytes.includes('"direction"'));
  assert.ok(!bytes.includes('mediator'));
  // flipping direction or adding a mediator does NOT change the same_as id
  const flippedDir: Relation = { ...base, direction: 'citing_to_cited' };
  const withMed: Relation = { ...base, mediator: { variable: 'v', condition: 'c', rationale: 'r' } };
  assert.equal(computeContentHash(flippedDir), computeContentHash(base));
  assert.equal(computeContentHash(withMed), computeContentHash(base));
  // pure hash IS endpoint-order-sensitive — the store sorts endpoints so the two
  // mirror submissions collapse to one id. (Store-level guarantee, smoke-tested.)
  const swapped: Relation = { ...base, source_claim_id: base.target_claim_id, target_claim_id: base.source_claim_id };
  assert.notEqual(computeContentHash(swapped), computeContentHash(base));
});

// ── A3 (final wave 2026-07-05): activity applied_instrument / genre ───────────
// Hash-INCLUDED when present; absent → omitted (§4.3) so existing activity ids do
// NOT shift. This locks that behavior alongside the golden vectors above.

const ACTIVITY: Activity = {
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

test('activity — applied_instrument/genre absent ⇒ omitted from canonical bytes (no id shift)', () => {
  const bytes = recordCanonicalBytes(ACTIVITY);
  // The guarantee that keeps existing activity ids stable: absent optional
  // hash-included fields are stripped before canonicalization (§4.3), so they
  // never appear in the bytes and cannot change the hash of a pre-A3 record.
  assert.ok(!bytes.includes('applied_instrument'));
  assert.ok(!bytes.includes('genre'));
});

test('activity — applied_instrument is hash-INCLUDED when present', () => {
  const withInstr: Activity = { ...ACTIVITY, applied_instrument: 'methodist_checkpoint' };
  const bytes = recordCanonicalBytes(withInstr);
  assert.ok(bytes.includes('applied_instrument'));
  assert.ok(bytes.includes('methodist_checkpoint'));
  assert.notEqual(computeContentHash(withInstr), computeContentHash(ACTIVITY));
});

test('activity — genre is hash-INCLUDED when present, independent of applied_instrument', () => {
  const withGenre: Activity = { ...ACTIVITY, genre: 'triz_review' };
  const withBoth: Activity = { ...ACTIVITY, applied_instrument: 'methodist_checkpoint', genre: 'triz_review' };
  assert.ok(recordCanonicalBytes(withGenre).includes('triz_review'));
  const hBase = computeContentHash(ACTIVITY);
  const hGenre = computeContentHash(withGenre);
  const hBoth = computeContentHash(withBoth);
  // three distinct hashes: base, genre-only, both — proves each field participates
  assert.notEqual(hGenre, hBase);
  assert.notEqual(hBoth, hBase);
  assert.notEqual(hBoth, hGenre);
});

// ── BUNDLE §4.3 identity (openarx-1ed5, bundle-by-reference) ──────────────────
// bundle_type + members = identity; members hashed as a SORTED SET (order-independent);
// synthesis_narrative is hash-EXCLUDED (projection). These lock the c3-St5 fix + guard
// against the pre-fix CLAIM_SCOPE degeneracy that collapsed a bundle scope to
// {attester_id, attested_at} (silent id collision).
const BUNDLE: Bundle = {
  id: 'PLACEHOLDER',
  record_type: 'bundle',
  bundle_type: 'narrative_synthesis',
  attester_id: 'agent:msi:openarx-research',
  attested_at: '2026-07-01T12:00:00Z',
  members: ['src:claim:bbb', 'src:claim:aaa', 'src:claim:ccc'],
  synthesis_narrative: 'UNIQUENARRATIVEXYZ — these claims converge on effect X.',
};

test('bundle — members hash as a SORTED SET (element order does not affect id)', () => {
  const ordered: Bundle = { ...BUNDLE, members: ['src:claim:aaa', 'src:claim:bbb', 'src:claim:ccc'] };
  const shuffled: Bundle = { ...BUNDLE, members: ['src:claim:ccc', 'src:claim:aaa', 'src:claim:bbb'] };
  assert.equal(computeContentHash(ordered), computeContentHash(shuffled));
});

test('bundle — synthesis_narrative is hash-EXCLUDED (projection: editing does not change id)', () => {
  const edited: Bundle = { ...BUNDLE, synthesis_narrative: 'A completely different narrative text.' };
  assert.equal(computeContentHash(edited), computeContentHash(BUNDLE));
  // neither the field key nor its distinctive value enters the canonical bytes
  const bytes = recordCanonicalBytes(BUNDLE);
  assert.ok(!bytes.includes('synthesis_narrative'));
  assert.ok(!bytes.includes('UNIQUENARRATIVEXYZ'));
});

test('bundle — bundle_type is hash-INCLUDED (discriminates kind)', () => {
  const roc: Bundle = { ...BUNDLE, bundle_type: 'ro_crate' };
  assert.notEqual(computeContentHash(roc), computeContentHash(BUNDLE));
  assert.ok(recordCanonicalBytes(BUNDLE).includes('narrative_synthesis'));
});

test('bundle — members participate in identity + no degenerate collapse (pre-fix CLAIM_SCOPE bug)', () => {
  // Two bundles differing ONLY in their member set must get DISTINCT ids. Under the old
  // CLAIM_SCOPE placeholder both collapsed to {attester_id, attested_at} → same id.
  const b1: Bundle = { ...BUNDLE, members: ['src:claim:aaa'] };
  const b2: Bundle = { ...BUNDLE, members: ['src:claim:bbb'] };
  assert.notEqual(computeContentHash(b1), computeContentHash(b2));
  // and the scope is non-degenerate: it carries bundle_type + members, not just attester/ts
  assert.ok(recordCanonicalBytes(b1).includes('members'));
  assert.ok(recordCanonicalBytes(b1).includes('bundle_type'));
});
