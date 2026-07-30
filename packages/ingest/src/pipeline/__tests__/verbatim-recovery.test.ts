/**
 * Functional sanity tests for verbatim-recovery (Stage-1 recoverSequence,
 * Stage-2 recoverFromAnchorPairs, shared coverageCheck).
 *
 * NOTE: this is behavioural-sanity, NOT the full bit-for-bit parity harness.
 * The full parity (per-chunk status/span identity vs the Python reference on the
 * 3587 Stage-1 + 6098 Stage-2 saved-corpus chunks) runs against the experimenter's
 * saved fixtures (vr_lib.py + parity_ts.ts) — coordinated as part of task .2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverSequence,
  recoverFromAnchorPairs,
  coverageCheck,
  isDroppableGap,
} from '../verbatim-recovery.js';

test('recoverSequence: LaTeX-normalized chunk → exact verbatim source slice', () => {
  // The chunker dropped `$` and `\` (`$95\%$` → `95%`) — recovery returns the exact source.
  const source = 'The model achieves an accuracy of $95\\%$ on the test set. We report results in Table 1.';
  const chunk = 'The model achieves an accuracy of 95% on the test set.';
  const [r] = recoverSequence([chunk], source);
  assert.equal(r.status, 'recovered');
  assert.equal(r.text, 'The model achieves an accuracy of $95\\%$ on the test set.');
});

test('recoverSequence: unmatched chunk → explicit FAILED (never silent)', () => {
  const source = 'Alpha beta gamma delta.';
  const [r] = recoverSequence(['zzz qqq xyz'], source);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.text, null);
});

test('recoverFromAnchorPairs: markers → exact between-marker slice (no reconcile)', () => {
  const source = 'Alpha beta gamma delta epsilon zeta eta theta.';
  const [r] = recoverFromAnchorPairs([['Alpha beta', 'epsilon zeta']], source, false);
  assert.equal(r.status, 'recovered');
  assert.equal(r.text, 'Alpha beta gamma delta epsilon zeta');
});

test('coverageCheck: full cover = clean tiling; partial = real gap', () => {
  const source = 'one two three.';
  const full = coverageCheck([[0, source.length]], source);
  assert.equal(full.cleanTiling, true);
  assert.equal(full.nGaps, 0);

  const partial = coverageCheck([[0, 3]], source);
  assert.equal(partial.cleanTiling, false);
  assert.ok(partial.nGaps >= 1);
});

test('isDroppableGap: blank / figure droppable; real prose is not', () => {
  assert.equal(isDroppableGap('   '), true);
  assert.equal(isDroppableGap('[Figure 1: architecture]'), true);
  assert.equal(isDroppableGap('a real sentence with words'), false);
});
