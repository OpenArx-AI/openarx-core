/**
 * B3 find_related_claims — the two rules the reviewers gated the build on, pinned by tests rather
 * than by comment. Both are pure, so they can be covered exhaustively; the search body itself is
 * verified against the live graph (it needs Qdrant + Neo4j).
 *
 * NB the run script supplies CORE_INTERNAL_SECRET because scientific-reads.ts constructs an
 * EmbedClient at MODULE level, so merely importing it demands the secret. That is a side effect at
 * import time and is worth removing (lazy construction) — noted rather than silently worked around;
 * the dummy value here only satisfies the constructor, nothing in these tests touches the network.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  clampAssociationFloor,
  classifyClaimOwnership,
} from '../scientific-reads.js';

test('the codified floor 0.62 applies when the caller says nothing', () => {
  assert.equal(clampAssociationFloor(undefined), 0.62);
});

test('★ min_score may RAISE the floor but never lower it', () => {
  assert.equal(clampAssociationFloor(0.9), 0.9, 'raising is allowed');
  assert.equal(clampAssociationFloor(0.1), 0.62, 'lowering must be ignored');
  assert.equal(clampAssociationFloor(0), 0.62);
  assert.equal(clampAssociationFloor(-5), 0.62, 'a negative floor must not open the gate');
  // A codified value any caller could lower by parameter would not be codified.
});

test('non-numeric min_score falls back to the codified floor rather than NaN', () => {
  assert.equal(clampAssociationFloor(Number.NaN), 0.62);
  assert.equal(clampAssociationFloor(Number.POSITIVE_INFINITY), 0.62);
  // Infinity is not finite, so it must NOT become an unreachable floor that silently returns nothing.
});

test('ownership: matching owner hashes → own', () => {
  assert.equal(classifyClaimOwnership('own:abc', 'own:abc'), 'own');
});

test('ownership: different owner hashes → foreign', () => {
  assert.equal(classifyClaimOwnership('own:abc', 'own:def'), 'foreign');
});

test('★ ownership: a missing hash on EITHER side → unknown, never a guess', () => {
  // Collapsing this into "foreign" would fabricate independent corroboration exactly where the
  // methodology checks for it — and it would compound a bias we already know about (our independence
  // metrics over-state independence). Collapsing it into "own" merely under-credits, but the honest
  // answer is a third value.
  assert.equal(classifyClaimOwnership(undefined, 'own:abc'), 'unknown', 'caller unknown');
  assert.equal(classifyClaimOwnership('own:abc', null), 'unknown', 'claim run has no owner_hash');
  assert.equal(classifyClaimOwnership(undefined, null), 'unknown', 'neither side known');
  assert.equal(classifyClaimOwnership('', 'own:abc'), 'unknown', 'empty is not a principal');
});

test('ownership never returns a value outside the three', () => {
  for (const [a, b] of [['own:x', 'own:x'], ['own:x', 'own:y'], [undefined, null]] as const) {
    assert.ok(['own', 'foreign', 'unknown'].includes(classifyClaimOwnership(a, b)));
  }
});
