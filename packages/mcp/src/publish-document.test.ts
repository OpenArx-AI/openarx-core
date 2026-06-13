/**
 * openarx-contracts-uhlh: publish-document pure-helper coverage. The IO
 * handler (consent fetch, storage, save, queue) is exercised by live prod
 * smoke; these cover the deterministic decision logic that drives every
 * response shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCaller,
  parseVersion,
  versionAtLeast,
  verifyPortalConsent,
  verifyAccountConsent,
  isAspect1ProviderFailure,
  validatePublishBody,
  isValidUserId,
  isUnsafeRelPath,
} from './publish-document.js';

const REQUIRED = {
  tos_version: 'v1.2', privacy_version: 'v1.1',
  dmca_version: 'v1.1', upload_consent_version: 'v1.1',
};
const NOW = Date.parse('2026-06-13T14:30:00.000Z');
const fresh = () => new Date(NOW - 60_000).toISOString();

// ── X-Caller (acceptance 2) ──
test('parseCaller accepts only portal/mcp', () => {
  assert.equal(parseCaller('portal'), 'portal');
  assert.equal(parseCaller('mcp'), 'mcp');
  assert.equal(parseCaller('admin'), null);
  assert.equal(parseCaller(undefined), null);
  assert.equal(parseCaller(['portal']), null); // header array
});

// ── version comparison ──
test('versionAtLeast handles ≥ semantics', () => {
  assert.equal(versionAtLeast('v1.1', 'v1.1'), true);
  assert.equal(versionAtLeast('v1.2', 'v1.1'), true);  // newer minor
  assert.equal(versionAtLeast('v2.0', 'v1.9'), true);  // newer major
  assert.equal(versionAtLeast('v1.0', 'v1.1'), false); // older minor
  assert.equal(versionAtLeast('v1', 'v1.0'), true);    // missing minor = .0
  assert.deepEqual(parseVersion('v1.2'), [1, 2]);
});

// ── caller=portal consent (acceptance 4, 5) ──
test('portal consent: all match + fresh → ok', () => {
  assert.deepEqual(verifyPortalConsent({ ...REQUIRED, accepted_at: fresh() }, REQUIRED, NOW), []);
});

test('portal consent: stale version → that key flagged (acceptance 5)', () => {
  const stale = verifyPortalConsent({ ...REQUIRED, upload_consent_version: 'v1.0', accepted_at: fresh() }, REQUIRED, NOW);
  assert.deepEqual(stale, ['upload_consent_version']);
});

test('portal consent: accepted_at older than 10 min → accepted_at flagged (acceptance 4)', () => {
  const old = new Date(NOW - 11 * 60_000).toISOString();
  assert.ok(verifyPortalConsent({ ...REQUIRED, accepted_at: old }, REQUIRED, NOW).includes('accepted_at'));
});

test('portal consent: exactly at 10-min boundary passes', () => {
  const boundary = new Date(NOW - 10 * 60_000).toISOString();
  assert.deepEqual(verifyPortalConsent({ ...REQUIRED, accepted_at: boundary }, REQUIRED, NOW), []);
});

test('portal consent: missing block → all keys stale', () => {
  assert.deepEqual(verifyPortalConsent(undefined, REQUIRED, NOW).sort(),
    ['dmca_version', 'privacy_version', 'tos_version', 'upload_consent_version']);
});

// ── caller=mcp account consent ──
test('account consent: newer versions accepted (≥)', () => {
  assert.deepEqual(verifyAccountConsent({ tos_version: 'v1.3', privacy_version: 'v1.1', dmca_version: 'v1.1', upload_consent_version: 'v2.0' }, REQUIRED), []);
});

test('account consent: stale upload version flagged', () => {
  assert.deepEqual(verifyAccountConsent({ ...REQUIRED, upload_consent_version: 'v1.0' }, REQUIRED), ['upload_consent_version']);
});

// ── Aspect 1 provider failure (acceptance 7) ──
test('aspect1 provider failure detected from LLM_TIMEOUT / upstream-unavailable', () => {
  const mk = (code: string) => ({ verdict: 'borderline' as const, reasons: [{ code } as never], llmCost: 0, llmAttempted: true });
  assert.equal(isAspect1ProviderFailure(mk('LLM_TIMEOUT')), true);
  assert.equal(isAspect1ProviderFailure(mk('LLM_SKIPPED_UPSTREAM_UNAVAILABLE')), true);
  assert.equal(isAspect1ProviderFailure(mk('LLM_CLASSIFIED_GENUINE')), false);
});

// ── body validation (acceptance 11) ──
const base = {
  user_id: 'u', title: 't', abstract: 'a', content_format: 'markdown',
  content_source: { type: 'text', text: '# x' }, license: 'cc-by-4.0',
  authors: [{ given_name: 'A', family_name: 'B' }],
};
test('validatePublishBody: happy path → null', () => {
  assert.equal(validatePublishBody({ ...base }), null);
});
test('validatePublishBody: missing required → message', () => {
  assert.ok(validatePublishBody({ ...base, title: undefined }));
  assert.ok(validatePublishBody({ ...base, authors: [] }));
});
test('validatePublishBody: bad format', () => {
  assert.match(validatePublishBody({ ...base, content_format: 'docx' }) ?? '', /content_format/);
});
test('validatePublishBody: size ceilings (6vz2)', () => {
  assert.match(validatePublishBody({ ...base, title: 'A'.repeat(5001) }) ?? '', /title/);
  assert.match(validatePublishBody({ ...base, abstract: 'A'.repeat(50001) }) ?? '', /abstract/);
  assert.match(validatePublishBody({ ...base, content_source: { type: 'text', text: 'A'.repeat(2_000_001) } }) ?? '', /content_source.text/);
  assert.match(validatePublishBody({ ...base, keywords: Array(51).fill('k') }) ?? '', /keywords/);
  assert.match(validatePublishBody({ ...base, keywords: ['A'.repeat(101)] }) ?? '', /keyword/);
});

// ── security guards (path traversal / arbitrary file access) ─────────────
test('isValidUserId accepts only UUIDs — blocks traversal + placeholders', () => {
  assert.equal(isValidUserId('3d4f8c2a-1b2c-4d5e-8f90-1a2b3c4d5e6f'), true);
  assert.equal(isValidUserId('_anonymous'), false);
  assert.equal(isValidUserId('_core'), false);
  assert.equal(isValidUserId('../../etc'), false);
  assert.equal(isValidUserId('..'), false);
  assert.equal(isValidUserId(undefined), false);
  assert.equal(isValidUserId(123), false);
});

test('isUnsafeRelPath flags traversal + absolute, allows normal nesting', () => {
  assert.equal(isUnsafeRelPath('../evil'), true);
  assert.equal(isUnsafeRelPath('a/../../b'), true);
  assert.equal(isUnsafeRelPath('/etc/passwd'), true);
  assert.equal(isUnsafeRelPath('C:\\win'), true);
  assert.equal(isUnsafeRelPath('main.tex'), false);
  assert.equal(isUnsafeRelPath('figures/fig1.png'), false);
});
