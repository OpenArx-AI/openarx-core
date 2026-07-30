/**
 * §8-inv4 run_id-threading (contracts EMPTY_LOG KEYING FIX; bead openarx-num1) — the run-ownership
 * identity helpers. ownerHashFromToken is the STABLE (refresh-immune) run owner; classifyRunOwnership
 * is the tool-call-boundary decision (REJECT-HARD foreign/absent, attribute owned, fallback otherwise).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerHashFromToken, credentialFromToken, classifyRunOwnership } from './portal-auth.js';

test('ownerHashFromToken is refresh-immune (userId-only) — unlike the token-composite credential', () => {
  // The composite credential ROTATES on token-refresh (different tokenId → different id)…
  const cred1 = credentialFromToken({ userId: 'u1', tokenId: 't1' });
  const cred2 = credentialFromToken({ userId: 'u1', tokenId: 't2' });
  assert.notEqual(cred1, cred2);
  // …but the owner hash is anchored to the STABLE userId, so it survives token-refresh.
  const own1 = ownerHashFromToken({ userId: 'u1' });
  const own2 = ownerHashFromToken({ userId: 'u1' });
  assert.equal(own1, own2);
  assert.match(own1, /^own:[0-9a-f]{40}$/);
});

test('ownerHashFromToken differs by principal (userId) and is anonymous without one', () => {
  assert.notEqual(ownerHashFromToken({ userId: 'u1' }), ownerHashFromToken({ userId: 'u2' }));
  assert.equal(ownerHashFromToken({ userId: undefined }), 'anonymous');
  assert.equal(ownerHashFromToken(undefined), 'anonymous');
});

test('classifyRunOwnership: lookup fault → fallback (never REJECT a legit call on an infra blip)', () => {
  // Faulted wins regardless of the (stale) ownerHash value.
  assert.deepEqual(classifyRunOwnership(undefined, 'own:aaa', true), { kind: 'fallback' });
  assert.deepEqual(classifyRunOwnership('own:bbb', 'own:aaa', true), { kind: 'fallback' });
});

test('classifyRunOwnership: absent run → REJECT unknown_run', () => {
  assert.deepEqual(classifyRunOwnership(undefined, 'own:aaa', false), { kind: 'reject', error: 'unknown_run' });
});

test('classifyRunOwnership: foreign owner → REJECT run_ownership_denied (cross-ward framing)', () => {
  assert.deepEqual(classifyRunOwnership('own:bbb', 'own:aaa', false), { kind: 'reject', error: 'run_ownership_denied' });
});

test('classifyRunOwnership: owned (owner_hash == caller) → attribute — incl. across token-refresh', () => {
  // The caller owner is derived from userId only, so a token-refreshed caller still matches its run.
  const owner = ownerHashFromToken({ userId: 'u1' });
  assert.deepEqual(classifyRunOwnership(owner, owner, false), { kind: 'attribute' });
});

test('classifyRunOwnership: pre-change run (owner_hash null) → fallback (backward-compat, no REJECT)', () => {
  assert.deepEqual(classifyRunOwnership(null, 'own:aaa', false), { kind: 'fallback' });
});
