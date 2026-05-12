import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cacheKey, sha256Hex } from './hash.js';

test('sha256Hex: deterministic', () => {
  assert.equal(sha256Hex('hello'), sha256Hex('hello'));
  assert.notEqual(sha256Hex('hello'), sha256Hex('hello2'));
});

test('cacheKey: includes model + dim + hash', () => {
  const k = cacheKey('gemini-embedding-2-preview', 3072, 'hello');
  assert.match(k, /^emb:gemini-embedding-2-preview:3072:[0-9a-f]{64}$/);
});

test('cacheKey: different model → different key', () => {
  const a = cacheKey('specter2', 768, 'hello');
  const b = cacheKey('gemini-embedding-2-preview', 3072, 'hello');
  assert.notEqual(a, b);
});
