/**
 * Tests for the two orthogonal availability axes (openarx-5xve):
 * computeSourceAccessibility + effectiveIndexingTier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Document } from '@openarx/types';
import { computeSourceAccessibility, effectiveIndexingTier } from './helpers.js';

const doc = (over: Partial<Document>): Document => over as Document;

test('computeSourceAccessibility — license gates delivery, not linking', () => {
  // Open / permissive → we serve the file ourselves.
  assert.equal(computeSourceAccessibility(doc({ license: 'CC-BY-4.0', sourceUrl: 'https://arxiv.org/abs/x' })), 'served_by_us');
  assert.equal(computeSourceAccessibility(doc({ license: 'NOASSERTION', sourceUrl: 'https://arxiv.org/abs/x' })), 'served_by_us');
  assert.equal(computeSourceAccessibility(doc({ license: null as unknown as string, sourceUrl: 'https://arxiv.org/abs/x' })), 'served_by_us');

  // Restricted license but a public source URL → agent self-fetches.
  assert.equal(
    computeSourceAccessibility(doc({ license: 'LicenseRef-arxiv-nonexclusive', sourceUrl: 'https://arxiv.org/abs/x' })),
    'external_link_only',
  );
  assert.equal(
    computeSourceAccessibility(doc({ license: 'CC-BY-NC-SA-4.0', sourceUrl: 'https://arxiv.org/abs/x' })),
    'external_link_only',
  );

  // Restricted AND no source URL → genuinely unavailable.
  assert.equal(
    computeSourceAccessibility(doc({ license: 'LicenseRef-arxiv-nonexclusive', sourceUrl: undefined as unknown as string })),
    'unavailable',
  );
});

test('effectiveIndexingTier — tier wins, else infer from chunkCount', () => {
  assert.equal(effectiveIndexingTier(doc({ indexingTier: 'full' }), 0), 'full');
  assert.equal(effectiveIndexingTier(doc({ indexingTier: 'abstract_only' }), 99), 'abstract_only');
  // null tier with chunks → legacy full default
  assert.equal(effectiveIndexingTier(doc({ indexingTier: undefined }), 12), 'full');
  // null tier, no chunks → genuinely unindexed
  assert.equal(effectiveIndexingTier(doc({ indexingTier: undefined }), 0), 'none');
});

test('orthogonality — full text indexed but file only external', () => {
  // The exact case agents misread: indexingTier=full, sourceAccessibility=external_link_only.
  const d = doc({ license: 'LicenseRef-arxiv-nonexclusive', sourceUrl: 'https://arxiv.org/abs/2405.14831', indexingTier: 'full' });
  assert.equal(effectiveIndexingTier(d, 35), 'full');
  assert.equal(computeSourceAccessibility(d), 'external_link_only');
});
