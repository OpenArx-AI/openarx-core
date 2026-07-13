import { describe, expect, it } from 'vitest';
import { applyReadSchema, type ReadSchema } from '../src/adapters/read-projection.js';

const claimRead: ReadSchema = { strip_fields: ['track_note'], pointer_when: { field: 'excerpt', unless: 'distributable' } };

describe('read-projection adapter (§12.7 · I2)', () => {
  it('strips strip_fields recursively (top-level + nested + arrays)', () => {
    const rec = {
      text: 'claim',
      track_note: 'internal',
      meta: { track_note: 'nested', keep: 1 },
      items: [{ track_note: 'x', v: 2 }],
    };
    expect(applyReadSchema(rec, { strip_fields: ['track_note'] })).toEqual({
      text: 'claim',
      meta: { keep: 1 },
      items: [{ v: 2 }],
    });
  });

  it('pointer_when: NOT distributable → field becomes a source pointer, not verbatim', () => {
    const rec = { excerpt: 'secret verbatim', distributable: false, source_uri: 'arxiv:1', track_note: 'z' };
    expect(applyReadSchema(rec, claimRead)).toEqual({
      excerpt: { pointer: 'arxiv:1' },
      distributable: false,
      source_uri: 'arxiv:1',
    });
  });

  it('pointer_when: distributable → excerpt stays verbatim', () => {
    const rec = { excerpt: 'open text', distributable: true, source_uri: 'arxiv:1' };
    expect(applyReadSchema(rec, claimRead).excerpt).toBe('open text');
  });

  it('pointer_when: MISSING gate (undefined) → pointer (I2-safe default, never leak)', () => {
    const rec = { excerpt: 'text', source_uri: 'arxiv:2' };
    expect(applyReadSchema(rec, claimRead).excerpt).toEqual({ pointer: 'arxiv:2' });
  });

  it('pointer with no source_uri → { pointer: null }', () => {
    const rec = { excerpt: 'text', distributable: false };
    expect(applyReadSchema(rec, claimRead).excerpt).toEqual({ pointer: null });
  });

  it('no schema → a fresh clone, unchanged', () => {
    const rec = { a: 1, b: { c: 2 } };
    const out = applyReadSchema(rec, undefined);
    expect(out).toEqual(rec);
    expect(out).not.toBe(rec);
  });
});
