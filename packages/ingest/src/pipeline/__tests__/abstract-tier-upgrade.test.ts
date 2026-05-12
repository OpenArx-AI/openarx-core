/**
 * TDD tests for isAbstractTierUpgrade — the resume-mode tier upgrade
 * detector that prevents serving abstract-only chunks for docs that have
 * since been promoted to full tier.
 *
 * Bug: openarx-hjpg (filed 2026-05-03 after observing 17K+ docs with
 * indexing_tier=full but parser_used=abstract_only and 21+ chunks each —
 * resume mode skipped re-parse on tier upgrade).
 *
 * Run: pnpm --filter @openarx/ingest test:abstract-tier-upgrade
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbstractTierUpgrade } from '../document-orchestrator.js';

// ── True positives (the bug case) ────────────────────────────

test('full tier + 1 chunk + prior abstract_only → upgrade detected', () => {
  assert.equal(isAbstractTierUpgrade('full', 1, 'abstract_only'), true);
});

// ── True negatives (must NOT misfire) ────────────────────────

test('current tier already abstract_only → no upgrade', () => {
  assert.equal(isAbstractTierUpgrade('abstract_only', 1, 'abstract_only'), false);
});

test('full tier + 1 chunk + prior latex → no upgrade (small full doc)', () => {
  // A tiny full LaTeX paper might legitimately yield a single chunk after
  // chunking — we must NOT force a rerun here.
  assert.equal(isAbstractTierUpgrade('full', 1, 'latex'), false);
});

test('full tier + 1 chunk + prior grobid → no upgrade', () => {
  assert.equal(isAbstractTierUpgrade('full', 1, 'grobid'), false);
});

test('full tier + 0 chunks + prior abstract_only → no upgrade (handled by virgin path)', () => {
  // 0 chunks is the "virgin" case — no resume ambiguity, normal route runs.
  assert.equal(isAbstractTierUpgrade('full', 0, 'abstract_only'), false);
});

test('full tier + 5 chunks + prior abstract_only → no upgrade (already body-chunked, just stale label)', () => {
  // Multiple chunks means a full chunker already ran (abstractChunkWorker
  // produces exactly 1 chunk). The parser_used label is stale but the
  // chunks themselves are full body — re-running would waste work.
  assert.equal(isAbstractTierUpgrade('full', 5, 'abstract_only'), false);
});

test('full tier + 1 chunk + prior null/unknown → no upgrade (unknown history)', () => {
  assert.equal(isAbstractTierUpgrade('full', 1, null), false);
  assert.equal(isAbstractTierUpgrade('full', 1, undefined), false);
  assert.equal(isAbstractTierUpgrade('full', 1, 'unknown'), false);
});

test('full tier + 1 chunk + prior mathpix → no upgrade', () => {
  assert.equal(isAbstractTierUpgrade('full', 1, 'mathpix'), false);
});

// ── Defensive: edge inputs ──────────────────────────────────

test('negative chunk count is treated as no upgrade', () => {
  // Defensive — should never happen but ensure we don't fire on garbage.
  assert.equal(isAbstractTierUpgrade('full', -1, 'abstract_only'), false);
});

test('large chunk count + abstract_only label → no upgrade', () => {
  assert.equal(isAbstractTierUpgrade('full', 50, 'abstract_only'), false);
  assert.equal(isAbstractTierUpgrade('full', 200, 'abstract_only'), false);
});
