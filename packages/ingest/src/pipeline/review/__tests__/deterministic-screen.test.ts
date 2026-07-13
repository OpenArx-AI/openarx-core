/**
 * §23 Tier-1 deterministic screen (contract 2a3ae4e) — pre-charge checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDeterministicScreen } from '../spam-screen.js';

const LONG = 'We study the effect of parameter scaling on convergence rates in stochastic optimization. '.repeat(8);
const ABSTRACT_OK = 'a'.repeat(150);

test('passes a normal submission (no reasons)', () => {
  assert.equal(runDeterministicScreen({ title: 'T', abstract: ABSTRACT_OK, body: LONG }), null);
});

test('EMPTY_BODY / BELOW_MIN_LENGTH hard checks reject', () => {
  assert.equal(runDeterministicScreen({ title: 'T', abstract: ABSTRACT_OK, body: '  ' })![0]!.code, 'EMPTY_BODY');
  assert.equal(
    runDeterministicScreen({ title: 'T', abstract: ABSTRACT_OK, body: 'short' })![0]!.code,
    'BELOW_MIN_LENGTH',
  );
});

test('ABSTRACT_TOO_SHORT is a Tier-1 reject (promoted by §23)', () => {
  const r = runDeterministicScreen({ title: 'T', abstract: 'tiny', body: LONG });
  assert.equal(r![0]!.code, 'ABSTRACT_TOO_SHORT');
});

test('REPETITIVE_CONTENT rejects', () => {
  const spam = 'buy now! '.repeat(80);
  const r = runDeterministicScreen({ title: 'T', abstract: ABSTRACT_OK, body: spam });
  assert.ok(r && ['REPETITIVE_CONTENT', 'BELOW_MIN_LENGTH'].includes(r[0]!.code));
});

test('empty abstract is NOT a deterministic reject (soft signal path unchanged)', () => {
  // NO_ABSTRACT stays a soft signal for the LLM tier — only a too-short
  // non-empty abstract is the §23 Tier-1 ABSTRACT_TOO_SHORT reject.
  assert.equal(runDeterministicScreen({ title: 'T', abstract: '', body: LONG }), null);
});
