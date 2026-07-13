import { describe, expect, it } from 'vitest';
import { graphMapping, relationLabel, type NodeSchema } from '../src/adapters/graph-mapping.js';

const claimNode: NodeSchema = { indexed_properties: ['attester_id', 'run_id', 'claim_status'] };
const relationNode: NodeSchema = { indexed_properties: ['attester_id', 'run_id', 'relation', 'direction', 'is_superseded'] };

describe('graph-mapping adapter (§12.7 · I1)', () => {
  it('picks the schema indexed_properties as native scalars; label=type, key=id, data=full record', () => {
    const rec = { id: 'oarx:claim:x', attester_id: 'agent:led', run_id: 'run:1', claim_status: 'proposed', text: 'a claim', track_note: 'internal' };
    expect(graphMapping('claim', rec, claimNode)).toEqual({
      label: 'claim',
      key: 'oarx:claim:x',
      scalars: { attester_id: 'agent:led', run_id: 'run:1', claim_status: 'proposed' },
      data: rec,
    });
  });

  it('indexes attester_id (I1 queryability) among the scalars', () => {
    const rec = { id: 'r', attester_id: 'agent:led', run_id: 'run:1', claim_status: 'proposed' };
    expect(graphMapping('claim', rec, claimNode).scalars.attester_id).toBe('agent:led');
  });

  it('skips indexed_properties absent on the record (present-only)', () => {
    const rec = { id: 'r', attester_id: 'a' }; // no run_id / claim_status
    expect(graphMapping('claim', rec, claimNode).scalars).toEqual({ attester_id: 'a' });
  });

  it('relation record: projects its own indexed_properties (relation/direction/is_superseded)', () => {
    const rec = { id: 'oarx:relation:y', attester_id: 'agent:led', run_id: 'run:1', relation: 'supports', direction: 'out', is_superseded: false, source_claim_id: 'c1', target_claim_id: 'c2' };
    const m = graphMapping('relation', rec, relationNode);
    expect(m.label).toBe('relation');
    // §12.8 (c): relation_class is always set on a relation node (default 'epistemic' when untagged).
    expect(m.scalars).toEqual({ attester_id: 'agent:led', run_id: 'run:1', relation: 'supports', direction: 'out', is_superseded: false, relation_class: 'epistemic' });
    // §12.8 Model C: the relation is BOTH a node-record (source/target stay in _data) AND a
    // companion TYPED edge projection — label = the relation type, edge carries only rel_id.
    expect(m.data.source_claim_id).toBe('c1');
    expect(m.edge).toEqual({ source: 'c1', target: 'c2', relId: 'oarx:relation:y', label: 'SUPPORTS' });
  });

  it('relationLabel: uppercases + sanitizes to a Cypher-safe relationship label', () => {
    expect(relationLabel('supports')).toBe('SUPPORTS');
    expect(relationLabel('same_as')).toBe('SAME_AS');
    expect(relationLabel('shares evidence-with')).toBe('SHARES_EVIDENCE_WITH');
    expect(relationLabel('')).toBe('RELATED');
    expect(relationLabel('  bad`;label  ')).toBe('BAD__LABEL');
  });

  // §12.8 (c) class-aware labels: engineering relations get a distinct ENG_ namespace so the
  // scientific §7 traversal/metrics never match them (non-confounding by label-space).
  it('relationLabel: engineering class → ENG_ namespace; epistemic/default → §7 label', () => {
    expect(relationLabel('depends_on', 'engineering')).toBe('ENG_DEPENDS_ON');
    expect(relationLabel('satisfies', 'engineering')).toBe('ENG_SATISFIES');
    expect(relationLabel('support', 'epistemic')).toBe('SUPPORT');
    expect(relationLabel('support')).toBe('SUPPORT'); // default = epistemic
    expect(relationLabel('', 'engineering')).toBe('ENG_RELATED');
  });

  it('graphMapping: engineering relation → relation_class scalar + ENG_ edge label; record_type stays relation', () => {
    const rec = { id: 'oarx:relation:e', relation: 'depends_on', relation_class: 'engineering', source_claim_id: 'c1', target_claim_id: 'c2' };
    const m = graphMapping('relation', rec, relationNode);
    expect(m.label).toBe('relation'); // one family
    expect(m.scalars.relation_class).toBe('engineering');
    expect(m.edge).toEqual({ source: 'c1', target: 'c2', relId: 'oarx:relation:e', label: 'ENG_DEPENDS_ON' });
  });

  it('symmetric relation (same_as): companion edge stored in canonical endpoint order', () => {
    const rec = { id: 'r', relation: 'same_as', source_claim_id: 'z9', target_claim_id: 'a1' };
    const m = graphMapping('relation', rec, relationNode);
    // record order is z9→a1 but same_as is symmetric → canonicalized to a1→z9 (smaller id first)
    expect(m.edge).toEqual({ source: 'a1', target: 'z9', relId: 'r', label: 'SAME_AS' });
  });

  it('relation record MISSING an endpoint → no companion edge (node-record still maps)', () => {
    const rec = { id: 'oarx:relation:z', attester_id: 'a', relation: 'supports', source_claim_id: 'c1' }; // no target
    const m = graphMapping('relation', rec, relationNode);
    expect(m.label).toBe('relation');
    expect(m.edge).toBeUndefined();
  });

  it('non-relation records carry no edge projection', () => {
    expect(graphMapping('claim', { id: 'c', attester_id: 'a' }, claimNode).edge).toBeUndefined();
  });

  it('no node schema → empty scalars (schema-driven; no hardcoded fallback)', () => {
    const rec = { id: 'r', attester_id: 'a' };
    expect(graphMapping('activity', rec, undefined).scalars).toEqual({});
  });

  it('missing id → empty key string (never undefined)', () => {
    expect(graphMapping('bundle', { attester_id: 'a' }, { indexed_properties: ['attester_id'] }).key).toBe('');
  });
});
