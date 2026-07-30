/**
 * Marker-mode WIRE keys (short names) — the tolerance property is the point of these tests.
 *
 * The model is now asked for short field names because the long ones repeated on every chunk and
 * cost ~23 of the 168 output tokens per chunk. The danger is not the renaming but STRICTNESS: the
 * long names are what the model has produced for months, so if a response written the old way
 * stopped parsing, the batch would fall through to the full-text path — making the run dearer, which
 * is the exact opposite of the change's purpose. So both spellings must work.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normaliseAnchorChunk } from '../chunker-step.js';

test('short wire keys map to the internal field names', () => {
  const out = normaliseAnchorChunk({
    sec: 'Introduction', sa: 'We study a space-time finite', ea: 'for a fixed error tolerance.',
    sum: 'A summary.', kc: 'space-time FEM', ct: 'methodology', ent: ['FEM'], sc: true,
  });
  assert.deepEqual(out, {
    section: 'Introduction',
    start_anchor: 'We study a space-time finite',
    end_anchor: 'for a fixed error tolerance.',
    summary: 'A summary.',
    key_concept: 'space-time FEM',
    content_type: 'methodology',
    entities: ['FEM'],
    self_contained: true,
  });
});

test('★ the ORIGINAL long keys still parse — a response written the old way must not fail the batch', () => {
  const out = normaliseAnchorChunk({
    section: 'Results', start_anchor: 'first eight words here', end_anchor: 'last eight words here',
    summary: 'S', key_concept: 'K', content_type: 'results', entities: ['A'], self_contained: false,
  });
  assert.equal(out?.section, 'Results');
  assert.equal(out?.start_anchor, 'first eight words here');
  assert.equal(out?.end_anchor, 'last eight words here');
  assert.equal(out?.self_contained, false);
});

test('a mixed response (some short, some long) parses, with short winning a conflict', () => {
  const out = normaliseAnchorChunk({
    section: 'Mixed', sa: 'short wins', start_anchor: 'long loses', ea: 'end here',
  });
  assert.equal(out?.section, 'Mixed');
  assert.equal(out?.start_anchor, 'short wins');
  assert.equal(out?.end_anchor, 'end here');
});

test('falsy-but-valid values survive (self_contained:false, empty entities)', () => {
  // A presence check written as `if (r[k])` would silently drop these; the implementation must test
  // for undefined instead.
  const out = normaliseAnchorChunk({ sec: 'S', sa: 'a', ea: 'b', sc: false, ent: [] });
  assert.equal(out?.self_contained, false);
  assert.deepEqual(out?.entities, []);
});

test('non-objects are rejected rather than coerced', () => {
  for (const bad of [null, undefined, 'string', 42, [], [{ sa: 'x' }]]) {
    if (Array.isArray(bad)) assert.equal(normaliseAnchorChunk(bad), null);
    else assert.equal(normaliseAnchorChunk(bad), null);
  }
});

test('unknown extra keys are dropped, not passed through', () => {
  const out = normaliseAnchorChunk({ sec: 'S', sa: 'a', ea: 'b', nonsense: 'x', text: 'full text' });
  assert.equal((out as Record<string, unknown>).nonsense, undefined);
  assert.equal((out as Record<string, unknown>).text, undefined, 'full text must not sneak back in');
});
