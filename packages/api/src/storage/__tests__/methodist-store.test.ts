/**
 * §13 methodist — hand-in hash (inv.2 idempotency key). Pure, no DB.
 * The stop-rule / journal / escalation mechanics need a DB and are covered by
 * integration / QA black-box.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handinHash } from '../methodist-store.js';

const base = { credential_id: 'agent:x', stage: 3, track_note: 'did the thing', artifacts: { map: [1, 2], note: 'ok' } };

test('handinHash — deterministic for identical input', () => {
  assert.equal(handinHash(base), handinHash({ ...base }));
});

test('handinHash — artifact key order does NOT change the hash (canonical)', () => {
  const reordered = { ...base, artifacts: { note: 'ok', map: [1, 2] } };
  assert.equal(handinHash(base), handinHash(reordered));
});

test('handinHash — stage as number vs string agree (String() normalization)', () => {
  assert.equal(handinHash({ ...base, stage: 3 }), handinHash({ ...base, stage: '3' }));
});

test('handinHash — a different hand-in yields a different hash', () => {
  assert.notEqual(handinHash(base), handinHash({ ...base, track_note: 'did something else' }));
  assert.notEqual(handinHash(base), handinHash({ ...base, stage: 4 }));
  assert.notEqual(handinHash(base), handinHash({ ...base, credential_id: 'agent:y' }));
});
