import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecordSchema } from '../layer2-validate.js';
import type { Activity, Claim, Metric, Relation } from '@openarx/types';

const VALID_CLAIM: Claim = {
  id: 'x',
  record_type: 'claim',
  attester_id: 'agent:a',
  attested_at: '2026-07-01T00:00:00Z',
  content: {
    text: 't',
    modality: 'empirical',
    claim_type: 'measurement',
    claim_strength: 0.5,
    extraction_fidelity: 0.5,
    claim_status: 'empirical_result',
  },
  evidence: [
    {
      source_uri: 'arxiv:1',
      excerpt: 'e',
      similarity_score: 0.9,
      provenance: 'own_experiment',
      retrieved_at: '2026-07-01T00:00:00Z',
    },
  ],
  chain_complete: true,
  source_digest: 'd',
};

test('claim — valid record passes schema conformance', () => {
  assert.deepEqual(validateRecordSchema(VALID_CLAIM), []);
});

test('claim — missing/invalid fields are each reported', () => {
  const bad = {
    ...VALID_CLAIM,
    attested_at: 'not-a-date',
    content: { ...VALID_CLAIM.content, claim_strength: 1.5, text: '' },
    evidence: [{ ...VALID_CLAIM.evidence[0]!, similarity_score: -1 }],
    chain_complete: 'yes' as unknown as boolean,
  } as Claim;
  const issues = validateRecordSchema(bad);
  const msgs = issues.map((i) => i.message).join('\n');
  assert.ok(issues.every((i) => i.code === 'schema_invalid'));
  assert.match(msgs, /attested_at/);
  assert.match(msgs, /claim_strength/);
  assert.match(msgs, /content\.text/);
  assert.match(msgs, /similarity_score/);
  assert.match(msgs, /chain_complete/);
});

test('claim — UNKNOWN enum values are accepted (server-side enum tolerance)', () => {
  const novel = {
    ...VALID_CLAIM,
    content: { ...VALID_CLAIM.content, modality: 'speculative_v2', claim_status: 'preprint_assertion' },
    evidence: [{ ...VALID_CLAIM.evidence[0]!, provenance: 'community_replication' }],
  } as Claim;
  assert.deepEqual(validateRecordSchema(novel), []);
});

const VALID_RELATION: Relation = {
  id: 'x',
  record_type: 'relation',
  attester_id: 'agent:a',
  attested_at: '2026-07-01T00:00:00Z',
  source_claim_id: 'agent:a:claim:' + 'a'.repeat(64),
  target_claim_id: 'agent:a:claim:' + 'b'.repeat(64),
  relation: 'support',
  direction: 'citing_to_cited',
  citation_context: { sentence: 's', preceding: 'p', following: 'f' },
  edge_provenance: { source: 'explicit_citation', confidence: 0.9 },
};

test('relation — valid; shared_evidence requires shared_* fields', () => {
  assert.deepEqual(validateRecordSchema(VALID_RELATION), []);
  const shared = { ...VALID_RELATION, relation: 'shared_evidence' } as Relation;
  const msgs = validateRecordSchema(shared).map((i) => i.message).join('\n');
  assert.match(msgs, /shared_source_uri/);
  assert.match(msgs, /interpretation_difference/);
});

test('relation — malformed mediator is reported', () => {
  const bad = { ...VALID_RELATION, mediator: { variable: 'v', condition: '', rationale: 'r' } } as Relation;
  const msgs = validateRecordSchema(bad).map((i) => i.message).join('\n');
  assert.match(msgs, /mediator\.condition/);
});

test('relation — citation_context is required for directed relations', () => {
  const noCite = { ...VALID_RELATION, citation_context: undefined } as unknown as Relation;
  const msgs = validateRecordSchema(noCite).map((i) => i.message).join('\n');
  assert.match(msgs, /citation_context: required/);
});

test('same_as — inference-based (no citation_context) is VALID (§7.6 P1)', () => {
  const inferred = {
    ...VALID_RELATION,
    relation: 'same_as',
    citation_context: undefined,
    edge_provenance: { source: 'platform_algorithmic', confidence: 0.8 },
  } as unknown as Relation;
  assert.deepEqual(validateRecordSchema(inferred), []);
});

test('same_as — citation-based STILL requires citation_context', () => {
  const cited = {
    ...VALID_RELATION,
    relation: 'same_as',
    citation_context: undefined,
    edge_provenance: { source: 'explicit_citation', confidence: 0.9 },
  } as unknown as Relation;
  const msgs = validateRecordSchema(cited).map((i) => i.message).join('\n');
  assert.match(msgs, /citation_context: required/);
});

test('same_as — present-but-malformed citation_context is shape-checked even when optional', () => {
  const bad = {
    ...VALID_RELATION,
    relation: 'same_as',
    citation_context: { sentence: 's', preceding: 'p' }, // missing following
    edge_provenance: { source: 'llm_inference', confidence: 0.7 },
  } as unknown as Relation;
  const msgs = validateRecordSchema(bad).map((i) => i.message).join('\n');
  assert.match(msgs, /citation_context\.following/);
});

test('same_as — a claim cannot be same_as itself (self-loop rejected)', () => {
  const loop = {
    ...VALID_RELATION,
    relation: 'same_as',
    target_claim_id: VALID_RELATION.source_claim_id,
    citation_context: undefined,
    edge_provenance: { source: 'semantic_similarity', confidence: 0.6 },
  } as unknown as Relation;
  const msgs = validateRecordSchema(loop).map((i) => i.message).join('\n');
  assert.match(msgs, /same_as: source_claim_id and target_claim_id must differ/);
});

const VALID_ACTIVITY: Activity = {
  id: 'x',
  record_type: 'activity',
  attester_id: 'agent:a',
  attested_at: '2026-07-01T00:00:00Z',
  activity_type: 'decision',
  started_at: '2026-07-01T00:00:00Z',
  ended_at: '2026-07-01T00:01:00Z',
  wasAssociatedWith: ['agent:a'],
  used: [],
  generated: [],
  wasInformedBy: [],
  activity_content: { trigger: 't', cycle_context: { cycle_type: '1', run_id: 'r', stage_id: 's' } },
};

test('activity — valid; missing cycle_context inside content is reported', () => {
  assert.deepEqual(validateRecordSchema(VALID_ACTIVITY), []);
  const bad = { ...VALID_ACTIVITY, activity_content: { trigger: 't' } } as unknown as Activity;
  const msgs = validateRecordSchema(bad).map((i) => i.message).join('\n');
  assert.match(msgs, /activity_content\.cycle_context/);
});

const VALID_METRIC: Metric = {
  id: 'x',
  record_type: 'metric',
  attester_id: 'agent:a',
  attested_at: '2026-07-01T00:00:00Z',
  metric_name: 'PCov',
  metric_value: 0.87,
  metric_type: 'ratio',
  computation: 'covered/total',
  wasGeneratedBy: 'agent:a:activity:' + 'c'.repeat(64),
  measures_entity: 'agent:a:bundle:' + 'd'.repeat(64),
  cycle_context: { cycle_type: '1', run_id: 'r', stage_id: 'final' },
};

test('metric — valid; non-finite value rejected', () => {
  assert.deepEqual(validateRecordSchema(VALID_METRIC), []);
  const bad = { ...VALID_METRIC, metric_value: Number.NaN } as Metric;
  const msgs = validateRecordSchema(bad).map((i) => i.message).join('\n');
  assert.match(msgs, /metric_value/);
});

test('bundle — manifest object required', () => {
  const msgs = validateRecordSchema({
    id: 'x',
    record_type: 'bundle',
    attester_id: 'agent:a',
    attested_at: '2026-07-01T00:00:00Z',
    manifest: null as unknown as Record<string, unknown>,
  }).map((i) => i.message).join('\n');
  assert.match(msgs, /manifest/);
});
