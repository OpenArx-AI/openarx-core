import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecordShape } from '../layer2-validate.js';

// ── validateRecordShape (ingress content validator; methodist checkpoint path) ────
// Enforces the LIVE relation form (contracts §7.6 ruling 2026-07-13): citation_context is a
// STRING (§4.3 identity-critical — it lives in the relation hash-scope), edge_provenance OPTIONAL.
const LIVE_EPISTEMIC: Record<string, unknown> = {
  record_type: 'relation',
  relation_class: 'epistemic',
  relation: 'support',
  direction: 'citing_to_cited',
  source_claim_id: 'agent:a:claim:x',
  target_claim_id: 'agent:a:claim:y',
  citation_context: 'the authors show X supports Y (p. 3)',
};
const shapeMsgs = (rec: unknown) =>
  validateRecordShape(rec, 'relation')
    .map((i) => i.message)
    .join('\n');

test('shape/relation — epistemic with STRING citation_context and no edge_provenance is VALID', () => {
  assert.deepEqual(validateRecordShape(LIVE_EPISTEMIC, 'relation'), []);
});

test('shape/relation — epistemic with OBJECT citation_context is REJECTED (must be string)', () => {
  assert.match(
    shapeMsgs({ ...LIVE_EPISTEMIC, citation_context: { sentence: 's' } }),
    /citation_context: required string/,
  );
});

test('shape/relation — epistemic missing citation_context is REJECTED', () => {
  const noCite = { ...LIVE_EPISTEMIC };
  delete noCite.citation_context;
  assert.match(shapeMsgs(noCite), /citation_context: required string/);
});

test('shape/relation — same_as without citation_context is VALID (inference-based)', () => {
  const sameAs: Record<string, unknown> = { ...LIVE_EPISTEMIC, relation: 'same_as' };
  delete sameAs.citation_context;
  assert.deepEqual(validateRecordShape(sameAs, 'relation'), []);
});

test('shape/relation — edge_provenance is OPTIONAL (its absence raises no issue)', () => {
  assert.ok(!shapeMsgs(LIVE_EPISTEMIC).includes('edge_provenance'));
});

test('shape/relation — engineering relation needs no citation_context/edge_provenance', () => {
  const eng: Record<string, unknown> = {
    ...LIVE_EPISTEMIC,
    relation_class: 'engineering',
    relation: 'depends_on',
  };
  delete eng.citation_context;
  assert.deepEqual(validateRecordShape(eng, 'relation'), []);
});

test('shape/relation — engineering with an epistemic enum value is REJECTED', () => {
  assert.match(
    shapeMsgs({ ...LIVE_EPISTEMIC, relation_class: 'engineering', relation: 'support' }),
    /not in the engineering enum/,
  );
});

// ── §12.1 bundle (openarx-1ed5): bundle_type discriminator + narrative_synthesis references ──
const NARRATIVE_BUNDLE: Record<string, unknown> = {
  record_type: 'bundle',
  bundle_type: 'narrative_synthesis',
  members: ['agent:a:claim:x', 'agent:a:claim:y'],
  synthesis_narrative: 'These claims converge on effect X.',
};
const bundleMsgs = (rec: unknown) =>
  validateRecordShape(rec, 'bundle').map((i) => i.message).join('\n');

test('shape/bundle — narrative_synthesis with members[] + synthesis_narrative is VALID', () => {
  assert.deepEqual(validateRecordShape(NARRATIVE_BUNDLE, 'bundle'), []);
});

test('shape/bundle — narrative_synthesis missing members is REJECTED (references required, no re-mint)', () => {
  const noMembers = { ...NARRATIVE_BUNDLE };
  delete noMembers.members;
  assert.match(bundleMsgs(noMembers), /members: required non-empty array/);
});

test('shape/bundle — narrative_synthesis empty members is REJECTED', () => {
  assert.match(bundleMsgs({ ...NARRATIVE_BUNDLE, members: [] }), /members: required non-empty array/);
});

test('shape/bundle — narrative_synthesis missing synthesis_narrative is REJECTED', () => {
  const noNarr = { ...NARRATIVE_BUNDLE };
  delete noNarr.synthesis_narrative;
  assert.match(bundleMsgs(noNarr), /synthesis_narrative: required/);
});

test('shape/bundle — unknown bundle_type is REJECTED (closed discriminator enum)', () => {
  assert.match(bundleMsgs({ ...NARRATIVE_BUNDLE, bundle_type: 'freeform' }), /bundle_type: required, one of/);
});

test('shape/bundle — ro_crate requires a manifest object', () => {
  assert.deepEqual(validateRecordShape({ record_type: 'bundle', bundle_type: 'ro_crate', manifest: { '@context': 'ro-crate' } }, 'bundle'), []);
  assert.match(bundleMsgs({ record_type: 'bundle', bundle_type: 'ro_crate' }), /manifest: required object/);
});

// ── §12.4 ward activity_type guard (openarx-0aof): deterministic strict {version_closeout} ────
test('shape/activity — version_closeout IS ward-submittable (VALID)', () => {
  assert.deepEqual(validateRecordShape({ record_type: 'activity', activity_type: 'version_closeout' }, 'activity'), []);
});

test('shape/activity — a non-version_closeout ward activity_type is REJECTED (deterministic guard)', () => {
  const msgs = validateRecordShape({ record_type: 'activity', activity_type: 'narrative_synthesis' }, 'activity')
    .map((i) => i.message).join('\n');
  assert.match(msgs, /not ward-submittable/);
});

test('shape/activity — missing activity_type is REJECTED (required)', () => {
  assert.match(
    validateRecordShape({ record_type: 'activity' }, 'activity').map((i) => i.message).join('\n'),
    /activity_type: required/,
  );
});
