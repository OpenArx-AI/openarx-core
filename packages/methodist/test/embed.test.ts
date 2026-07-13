import { describe, expect, it } from 'vitest';
import { buildEmbed, embedPayload, embedProjection, renderTemplate, type VectorSchema } from '../src/adapters/embed.js';

// the real claim vector schema (record_schemas.json)
const claimVector: VectorSchema = {
  projection: '[Context] {{run}} {{edges}}\n[Claim] {{text}} {{caveats}}',
  payload: ['modality', 'claim_type', 'claim_status', 'verification_outcome', 'attester_id', 'run_id', 'is_superseded', 'attested_at'],
  payload_indexed: { keyword: ['claim_type', 'claim_status', 'attester_id', 'run_id'], bool: ['is_superseded'] },
  models: ['gemini', 'specter2'],
};

describe('embed adapter (§12.7 · I3)', () => {
  it('renderTemplate substitutes {{field}}; missing → empty', () => {
    expect(renderTemplate('a {{x}} b {{y}} c', { x: 'X' })).toBe('a X b  c');
    expect(renderTemplate('{{ spaced }}', { spaced: 1 })).toBe('1');
  });

  it('projection: DIRECT record fields ({{text}},{{caveats}}) + COMPUTED ({{run}},{{edges}}) merged', () => {
    const record = { text: 'the claim', caveats: '(small n)' };
    const computed = { run: 'Run r1 (cycle 3).', edges: 'supports c2.' };
    expect(embedProjection(record, claimVector, computed)).toBe('[Context] Run r1 (cycle 3). supports c2.\n[Claim] the claim (small n)');
  });

  it('projection: computed edges/run absent → placeholders render empty (no crash)', () => {
    expect(embedProjection({ text: 't', caveats: '' }, claimVector)).toBe('[Context]  \n[Claim] t ');
  });

  it('payload: picks schema payload fields present-only', () => {
    const record = { claim_type: 'empirical', claim_status: 'proposed', attester_id: 'agent:led', run_id: 'run:1', is_superseded: false, text: 'ignored', track_note: 'internal' };
    expect(embedPayload(record, claimVector)).toEqual({
      claim_type: 'empirical',
      claim_status: 'proposed',
      attester_id: 'agent:led',
      run_id: 'run:1',
      is_superseded: false,
    });
  });

  it('buildEmbed: text + payload + models together', () => {
    const record = { text: 'c', caveats: '', claim_status: 'proposed', attester_id: 'a' };
    const out = buildEmbed(record, claimVector, { run: 'Run r1.', edges: '' });
    expect(out.models).toEqual(['gemini', 'specter2']);
    expect(out.payload).toEqual({ claim_status: 'proposed', attester_id: 'a' });
    expect(out.text).toContain('[Claim] c');
  });

  it('no vector schema → empty text, empty payload, no models', () => {
    expect(buildEmbed({ text: 't' }, undefined)).toEqual({ text: '', payload: {}, models: [] });
  });
});
