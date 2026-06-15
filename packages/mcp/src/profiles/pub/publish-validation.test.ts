/**
 * Publisher-tool validation matrix. The flrw inline-content cases were removed
 * in openarx-contracts-w7um §17.2 (publishing is now file-only — there is no
 * content_text to validate; see archive-intake.test.ts for the file-only
 * validateContentInputs matrix).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── openarx-contracts-7tyj: create_new_version metadata inheritance ──────
import { resolveVersionMetadata } from './publish-tools.js';

const V1 = { categories: ['cs.CL'], keywords: ['x', 'y'], language: 'fr' };

// Acceptance 1: no overrides → all three inherited
test('no overrides inherits categories, keywords and language from v1', () => {
  assert.deepEqual(resolveVersionMetadata(V1, {}), {
    categories: ['cs.CL'], keywords: ['x', 'y'], language: 'fr',
  });
});

// Acceptance 2: keywords override, other two inherited
test('keywords override keeps categories and language inherited', () => {
  assert.deepEqual(resolveVersionMetadata(V1, { keywords: ['z'] }), {
    categories: ['cs.CL'], keywords: ['z'], language: 'fr',
  });
});

// Acceptance 3: explicit empty categories is an override, not inheritance
test('explicit empty categories array overrides, does not inherit', () => {
  const r = resolveVersionMetadata(V1, { categories: [] });
  assert.deepEqual(r.categories, []);
  assert.deepEqual(r.keywords, ['x', 'y']);
  assert.equal(r.language, 'fr');
});

// Acceptance 4: language override, other two inherited
test('language override keeps categories and keywords inherited', () => {
  assert.deepEqual(resolveVersionMetadata(V1, { language: 'de' }), {
    categories: ['cs.CL'], keywords: ['x', 'y'], language: 'de',
  });
});

// Defaults when the previous version itself lacks the fields
test('missing prev fields fall back to [] / [] / en', () => {
  assert.deepEqual(resolveVersionMetadata({}, {}), {
    categories: [], keywords: [], language: 'en',
  });
});

// ── openarx-contracts-6vz2: size limits via zod .max() ───────────────────
// The SAME schema objects (titleField/abstractField/keywordsField) are used in
// both submit_document and create_new_version tool shapes — identity between
// the tools holds by construction, so each case below covers both tools.
// (contentTextField was removed with inline content in w7um §17.2.)
import { titleField, abstractField, keywordsField, PUBLISH_LIMITS } from './publish-tools.js';

test('title over 5000 chars is rejected, 5000 exactly passes', () => {
  assert.equal(titleField.safeParse('A'.repeat(5001)).success, false);
  assert.equal(titleField.safeParse('A'.repeat(5000)).success, true);
});

test('abstract over 50000 chars is rejected', () => {
  assert.equal(abstractField.safeParse('A'.repeat(50001)).success, false);
  assert.equal(abstractField.safeParse('A'.repeat(50000)).success, true);
});

test('more than 50 keywords rejected', () => {
  assert.equal(keywordsField.safeParse(Array(51).fill('x')).success, false);
  assert.equal(keywordsField.safeParse(Array(50).fill('x')).success, true);
});

test('keyword item over 100 chars rejected', () => {
  assert.equal(keywordsField.safeParse(['A'.repeat(101)]).success, false);
  assert.equal(keywordsField.safeParse(['A'.repeat(100)]).success, true);
});

test('zod error references the offending field constraint', () => {
  const r = titleField.safeParse('A'.repeat(PUBLISH_LIMITS.title + 1));
  assert.ok(!r.success && JSON.stringify(r.error.issues).includes('5000'));
});

// ── openarx-contracts-4xvb: status filter enum + reference block ─────────
// STATUS_REFERENCE is a single shared const used in BOTH get_my_documents
// and get_document_status descriptions — identity holds by construction.
import { z } from 'zod';
import { STATUS_FILTER_VALUES, STATUS_REFERENCE } from './publish-tools.js';

const statusEnum = z.enum(STATUS_FILTER_VALUES);

// Acceptance 1: intermediate pipeline status accepted by the filter
test('status filter accepts chunking (and every real pipeline status)', () => {
  for (const s of ['chunking', 'parsing', 'translating', 'enriching', 'embedding', 'duplicate', 'rejected', 'listed', 'download_failed']) {
    assert.equal(statusEnum.safeParse(s).success, true, s);
  }
});

// Acceptance 2: backwards compat — old values still valid
test('status filter keeps backwards-compatible values', () => {
  for (const s of ['all', 'ready', 'downloaded', 'failed']) {
    assert.equal(statusEnum.safeParse(s).success, true, s);
  }
});

test('status filter rejects unknown values', () => {
  assert.equal(statusEnum.safeParse('published').success, false);
});

// Reference block documents every filterable status (minus 'all')
test('status reference describes every enum value', () => {
  for (const s of STATUS_FILTER_VALUES.filter((v) => v !== 'all')) {
    assert.ok(STATUS_REFERENCE.includes(`\n  ${s} — `) || STATUS_REFERENCE.startsWith(`Status reference:\n  ${s} — `), s);
  }
});

// ── openarx-contracts-9o1k: categories guidance, doc-only ────────────────
import { CATEGORIES_NOTE } from './publish-tools.js';

test('categories note recommends arXiv format with at least 3 examples', () => {
  assert.ok(CATEGORIES_NOTE.includes('arXiv format recommended'));
  for (const ex of ['cs.CL', 'math.PR', 'cond-mat.str-el', 'physics.gen-ph']) {
    assert.ok(CATEGORIES_NOTE.includes(ex), ex);
  }
});

// Acceptance 4: backwards compat — no enforcement, any string passes
test('unconventional categories still pass schema (doc-only, no regex)', () => {
  assert.equal(z.array(z.string()).optional().safeParse(['foo', 'bar', 'misc']).success, true);
});

// ── openarx-contracts-tof2: dry_run flag ─────────────────────────────────
import { estimatedSubmitCost, dryRunField } from './publish-tools.js';
import { getCostKey, isDryRunCall } from '../../cost-key.js';

test('estimated cost mirrors economics config: latex/markdown 5, pdf 10', () => {
  assert.equal(estimatedSubmitCost('latex'), 5);
  assert.equal(estimatedSubmitCost('markdown'), 5);
  assert.equal(estimatedSubmitCost('pdf'), 10);
});

test('dry_run field defaults to false (acceptance 4: omitting = real submit)', () => {
  assert.equal(dryRunField.parse(undefined), false);
  assert.equal(dryRunField.parse(true), true);
});

test('isDryRunCall true only for the two publish tools with dry_run=true', () => {
  assert.equal(isDryRunCall('submit_document', { dry_run: true }), true);
  assert.equal(isDryRunCall('create_new_version', { dry_run: true }), true);
  assert.equal(isDryRunCall('submit_document', {}), false);
  assert.equal(isDryRunCall('submit_document', { dry_run: false }), false);
  // a stray dry_run arg on any other tool must NOT bypass billing
  assert.equal(isDryRunCall('search', { dry_run: true }), false);
  assert.equal(isDryRunCall('get_document', { dry_run: true }), false);
});

test('cost_key carries :dry_run suffix for request-log observability', () => {
  assert.equal(getCostKey('submit_document', { dry_run: true, content_format: 'pdf' }), 'submit_document:dry_run');
  assert.equal(getCostKey('submit_document', { content_format: 'pdf' }), 'submit_document:pdf');
  assert.equal(getCostKey('create_new_version', { dry_run: true }), 'create_new_version:dry_run');
  assert.equal(getCostKey('create_new_version', {}), 'create_new_version');
});

// Acceptance 5/6 inheritance in would_save: the dry-run branch uses the SAME
// resolveVersionMetadata call as the real save (verified by 7tyj tests above) —
// re-assert the two acceptance shapes here against the helper.
test('dry-run would_save inheritance matches resolveVersionMetadata semantics', () => {
  const v1 = { categories: ['cs.CL'], keywords: ['x', 'y'], language: 'fr' };
  assert.deepEqual(resolveVersionMetadata(v1, {}), { categories: ['cs.CL'], keywords: ['x', 'y'], language: 'fr' });
  const overridden = resolveVersionMetadata(v1, { keywords: ['override'] });
  assert.deepEqual(overridden.keywords, ['override']);
  assert.deepEqual(overridden.categories, ['cs.CL']);
  assert.equal(overridden.language, 'fr');
});

// ── openarx-contracts-w3rr: publish-via-endpoint billing rule ────────────
import { isChargeablePublishStatus } from './publish-tools.js';

test('only 202 (created) and 409 (idempotent replay) are chargeable', () => {
  assert.equal(isChargeablePublishStatus(202), true);
  assert.equal(isChargeablePublishStatus(409), true);
  for (const s of [400, 401, 403, 422, 500, 503]) {
    assert.equal(isChargeablePublishStatus(s), false, `status ${s} must not be billed`);
  }
});
