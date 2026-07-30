/**
 * S6(1)/S6(3) checkpoint-payload lenient-parse (contracts "CHECKPOINT PAYLOAD LENIENT-PARSE RULING",
 * batch-3). Tolerate a JSON-stringified payload/submission/records (Postel); fail LOUD on a
 * genuinely-malformed string; and — the key invariant (abvc-A) — parse to an object DEEP-EQUAL to the
 * native one so the server-derived submission_hash is identical either way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lenientJson } from './lenient-parse.js';

test('native object/array pass through UNCHANGED (same ref; semantics identical to the object path)', () => {
  const obj = { submission: { records: [1, 2] }, stage: 3 };
  const r = lenientJson(obj, 'payload', 'object');
  assert.deepEqual(r, { ok: true, value: obj });
  assert.equal((r as { value: unknown }).value, obj); // same reference — not re-shaped

  const arr = [{ a: 1 }];
  const ra = lenientJson(arr, 'records', 'array');
  assert.equal((ra as { value: unknown }).value, arr);
});

test('JSON-string of an object → parsed object (Postel)', () => {
  const obj = { intent: 'survey', focus: 'x' };
  const r = lenientJson(JSON.stringify(obj), 'payload', 'object');
  assert.deepEqual(r, { ok: true, value: obj });
});

test('JSON-string of an array → parsed array (records)', () => {
  const arr = [{ kind: 'claim' }, { kind: 'relation' }];
  const r = lenientJson(JSON.stringify(arr), 'records', 'array');
  assert.deepEqual(r, { ok: true, value: arr });
});

test('★ abvc-A idempotency: a json-string of an object parses DEEP-EQUAL to the native object', () => {
  // The submission_hash is computed over this value; object-input and json-string-of-same-object
  // must be indistinguishable post-parse so the hash (and §2g replay) is identical.
  const submission = { records: [{ kind: 'claim', content: { text: 'c' } }], track_note: 'note' };
  const fromObject = lenientJson(submission, 'submission', 'object');
  const fromString = lenientJson(JSON.stringify(submission), 'submission', 'object');
  assert.equal(fromObject.ok, true);
  assert.equal(fromString.ok, true);
  assert.deepEqual((fromString as { value: unknown }).value, (fromObject as { value: unknown }).value);
  assert.deepEqual((fromString as { value: unknown }).value, submission);
});

test('S6(3) fail-loud: a non-JSON string → <field>_unparseable (deterministic, diagnosable)', () => {
  const r = lenientJson('not json {{{', 'payload', 'object');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'payload_unparseable');
  assert.match((r as { message: string }).message, /not valid JSON/);
});

test('S6(3) fail-loud: a JSON string that parses to a non-object (expect object) → <field>_not_object', () => {
  const r = lenientJson('42', 'payload', 'object'); // valid JSON, but a number
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'payload_not_object');

  const arrAsObj = lenientJson('[1,2]', 'payload', 'object'); // array where object expected
  assert.equal(arrAsObj.ok, false);
  assert.equal((arrAsObj as { reason: string }).reason, 'payload_not_object');
});

test('S6(3) fail-loud: a JSON string that parses to a non-array (expect array) → <field>_not_array', () => {
  const r = lenientJson('{"a":1}', 'records', 'array'); // object where array expected
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'records_not_array');
});

test('null/undefined pass through (empty-payload path unchanged)', () => {
  assert.deepEqual(lenientJson(undefined, 'payload', 'object'), { ok: true, value: undefined });
  assert.deepEqual(lenientJson(null, 'payload', 'object'), { ok: true, value: null });
});
