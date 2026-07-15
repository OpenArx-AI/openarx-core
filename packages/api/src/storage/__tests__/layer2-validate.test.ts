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
