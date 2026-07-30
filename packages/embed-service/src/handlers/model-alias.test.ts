/**
 * Model-name resolution at the API boundary (Stage-2 Phase-2 of the embedding_qwen_migration).
 *
 * The specter2 MODEL is gone from this service, but the name still names the PHYSICAL 768-dim
 * Qdrant vector (which now holds qwen), so a straggler caller may still ask for it. Such a request
 * must be served by qwen rather than rejected — and the response must report the resolved model, so
 * the substitution is visible instead of silent.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MODEL_ALIASES, resolveModel } from './types.js';

test('legacy alias specter2 resolves to qwen3-embedding-8b', () => {
  assert.equal(resolveModel('specter2'), 'qwen3-embedding-8b');
  assert.equal(MODEL_ALIASES.specter2, 'qwen3-embedding-8b');
});

test('real model names resolve to themselves', () => {
  assert.equal(resolveModel('qwen3-embedding-8b'), 'qwen3-embedding-8b');
  assert.equal(resolveModel('gemini-embedding-2-preview'), 'gemini-embedding-2-preview');
});

test('unknown model names do NOT resolve (the caller must get a 400, not a silent substitution)', () => {
  assert.equal(resolveModel('specter'), undefined);
  assert.equal(resolveModel('text-embedding-004'), undefined);
  assert.equal(resolveModel(''), undefined);
  assert.equal(resolveModel('qwen3-embedding-8b '), undefined); // no trimming: exact names only
});

test('every alias points at a real model, never at another alias', () => {
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    assert.equal(resolveModel(target), target, `${alias} → ${target} must itself be a real model`);
    assert.equal(alias in MODEL_ALIASES && target in MODEL_ALIASES, false, 'no alias chains');
  }
});
