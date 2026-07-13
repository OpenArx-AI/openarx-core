import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecordId,
  parseRecordId,
  RECORD_TYPES,
  KNOWN_RELATIONS,
  HASH_INCLUDED_FIELDS,
  HASH_EXCLUDED_FIELDS,
} from './layer2.js';

const HASH = 'a'.repeat(64); // 64 hex chars

test('buildRecordId / parseRecordId roundtrip — colon inside source_prefix', () => {
  const prefix = 'agent:msi:openarx-research';
  const id = buildRecordId(prefix, 'claim', HASH);
  assert.equal(id, `${prefix}:claim:${HASH}`);
  const parsed = parseRecordId(id);
  assert.deepEqual(parsed, { sourcePrefix: prefix, recordType: 'claim', contentHash: HASH });
});

test('parseRecordId — human and platform prefixes', () => {
  assert.deepEqual(parseRecordId(`human:u-123:metric:${HASH}`), {
    sourcePrefix: 'human:u-123',
    recordType: 'metric',
    contentHash: HASH,
  });
  assert.deepEqual(parseRecordId(`platform:algorithm:edge-infer:relation:${HASH}`), {
    sourcePrefix: 'platform:algorithm:edge-infer',
    recordType: 'relation',
    contentHash: HASH,
  });
});

test('parseRecordId — rejects malformed ids', () => {
  assert.equal(parseRecordId('agent:x:claim:nothex'), null); // hash not 64-hex
  assert.equal(parseRecordId(`agent:x:widget:${HASH}`), null); // unknown record_type
  assert.equal(parseRecordId(`claim:${HASH}`), null); // empty source_prefix
  assert.equal(parseRecordId('too:short'), null);
});

test('hash-scope maps cover all record types and are disjoint from excluded', () => {
  for (const rt of RECORD_TYPES) {
    assert.ok(HASH_INCLUDED_FIELDS[rt].length > 0, `${rt} has included fields`);
    for (const f of HASH_INCLUDED_FIELDS[rt]) {
      assert.ok(
        !(HASH_EXCLUDED_FIELDS as readonly string[]).includes(f),
        `${rt}.${f} must not be in both included and excluded`,
      );
    }
  }
  // spot-check the catastrophic-breaking scope (§4.3)
  assert.ok(HASH_INCLUDED_FIELDS.claim.includes('content'));
  assert.ok(HASH_INCLUDED_FIELDS.claim.includes('evidence'));
  assert.ok(!(HASH_INCLUDED_FIELDS.claim as readonly string[]).includes('consent_scope'));
  assert.ok(HASH_INCLUDED_FIELDS.relation.includes('mediator'));
});

test('KNOWN_RELATIONS = six ClaimFlow types + same_as (A1/P1, symmetric)', () => {
  assert.deepEqual([...KNOWN_RELATIONS], [
    'support',
    'extend',
    'qualify',
    'refute',
    'background',
    'shared_evidence',
    'same_as',
  ]);
});
