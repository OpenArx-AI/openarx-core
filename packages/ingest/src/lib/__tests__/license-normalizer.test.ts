import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLicense, isOpenLicense, computeEffectiveLicense } from '../license-normalizer.js';

// ── arXiv URL forms (real arXiv OAI-PMH responses) ────────────

test('arXiv non-exclusive distribution license URL', () => {
  const result = normalizeLicense('http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
  assert.equal(result.spdx, 'LicenseRef-arxiv-nonexclusive');
  assert.equal(result.is_open, false);
  assert.equal(result.raw, 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
});

test('arXiv assumed legacy license URL', () => {
  const result = normalizeLicense('http://arxiv.org/licenses/assumed-1991-2003/');
  assert.equal(result.spdx, 'LicenseRef-arxiv-assumed');
  assert.equal(result.is_open, false);
});

// ── Creative Commons URL forms ───────────────────────────────

test('CC BY 4.0 URL', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by/4.0/');
  assert.equal(result.spdx, 'CC-BY-4.0');
  assert.equal(result.is_open, true);
});

test('CC BY-SA 4.0 URL', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(result.spdx, 'CC-BY-SA-4.0');
  assert.equal(result.is_open, true);
});

test('CC BY-NC 4.0 URL', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by-nc/4.0/');
  assert.equal(result.spdx, 'CC-BY-NC-4.0');
  assert.equal(result.is_open, false);
});

test('CC BY-NC-SA 4.0 URL', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by-nc-sa/4.0/');
  assert.equal(result.spdx, 'CC-BY-NC-SA-4.0');
  assert.equal(result.is_open, false);
});

test('CC BY-NC-ND 4.0 URL', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by-nc-nd/4.0/');
  assert.equal(result.spdx, 'CC-BY-NC-ND-4.0');
  assert.equal(result.is_open, false);
});

test('CC BY-ND 4.0 URL', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by-nd/4.0/');
  assert.equal(result.spdx, 'CC-BY-ND-4.0');
  assert.equal(result.is_open, false);
});

test('CC BY 3.0 URL (older version)', () => {
  const result = normalizeLicense('http://creativecommons.org/licenses/by/3.0/');
  assert.equal(result.spdx, 'CC-BY-3.0');
  assert.equal(result.is_open, true);
});

test('CC0 URL (public domain dedication)', () => {
  const result = normalizeLicense('http://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(result.spdx, 'CC0-1.0');
  assert.equal(result.is_open, true);
});

test('Public domain mark URL', () => {
  const result = normalizeLicense('http://creativecommons.org/publicdomain/mark/1.0/');
  assert.equal(result.spdx, 'CC-PDDC');
  assert.equal(result.is_open, true);
});

test('HTTPS variant of CC BY URL', () => {
  const result = normalizeLicense('https://creativecommons.org/licenses/by/4.0/');
  assert.equal(result.spdx, 'CC-BY-4.0');
  assert.equal(result.is_open, true);
});

// ── SPDX-style strings (OpenAlex, Unpaywall format) ───────────

test('SPDX CC-BY-4.0 string', () => {
  const result = normalizeLicense('CC-BY-4.0');
  assert.equal(result.spdx, 'CC-BY-4.0');
  assert.equal(result.is_open, true);
});

test('SPDX CC-BY-NC-ND-4.0 string', () => {
  const result = normalizeLicense('CC-BY-NC-ND-4.0');
  assert.equal(result.spdx, 'CC-BY-NC-ND-4.0');
  assert.equal(result.is_open, false);
});

test('SPDX CC0-1.0 string', () => {
  const result = normalizeLicense('CC0-1.0');
  assert.equal(result.spdx, 'CC0-1.0');
  assert.equal(result.is_open, true);
});

test('lowercase cc-by-4.0', () => {
  const result = normalizeLicense('cc-by-4.0');
  assert.equal(result.spdx, 'CC-BY-4.0');
  assert.equal(result.is_open, true);
});

// ── Loose strings ─────────────────────────────────────────────

test('bare cc-by → assume 4.0', () => {
  const result = normalizeLicense('cc-by');
  assert.equal(result.spdx, 'CC-BY-4.0');
  assert.equal(result.is_open, true);
});

test('bare cc-by-sa → assume 4.0', () => {
  const result = normalizeLicense('cc-by-sa');
  assert.equal(result.spdx, 'CC-BY-SA-4.0');
  assert.equal(result.is_open, true);
});

test('bare cc-by-nc → assume 4.0', () => {
  const result = normalizeLicense('cc-by-nc');
  assert.equal(result.spdx, 'CC-BY-NC-4.0');
  assert.equal(result.is_open, false);
});

test('cc0 short form', () => {
  const result = normalizeLicense('cc0');
  assert.equal(result.spdx, 'CC0-1.0');
  assert.equal(result.is_open, true);
});

test('public-domain string', () => {
  const result = normalizeLicense('public-domain');
  assert.equal(result.spdx, 'CC-PDDC');
  assert.equal(result.is_open, true);
});

test('"public domain" with space', () => {
  const result = normalizeLicense('public domain');
  assert.equal(result.spdx, 'CC-PDDC');
  assert.equal(result.is_open, true);
});

test('underscore separator: cc_by_4_0', () => {
  const result = normalizeLicense('cc_by_4.0');
  assert.equal(result.spdx, 'CC-BY-4.0');
  assert.equal(result.is_open, true);
});

// ── Whitespace and edge cases ─────────────────────────────────

test('whitespace trimmed', () => {
  const result = normalizeLicense('  CC-BY-4.0  ');
  assert.equal(result.spdx, 'CC-BY-4.0');
});

test('null input → NOASSERTION', () => {
  const result = normalizeLicense(null);
  assert.equal(result.spdx, 'NOASSERTION');
  assert.equal(result.is_open, true); // permissive default
  assert.equal(result.raw, null);
});

test('undefined input → NOASSERTION', () => {
  const result = normalizeLicense(undefined);
  assert.equal(result.spdx, 'NOASSERTION');
  assert.equal(result.is_open, true);
});

test('empty string → NOASSERTION', () => {
  const result = normalizeLicense('');
  assert.equal(result.spdx, 'NOASSERTION');
  assert.equal(result.is_open, true);
});

test('whitespace-only → NOASSERTION', () => {
  const result = normalizeLicense('   ');
  assert.equal(result.spdx, 'NOASSERTION');
  assert.equal(result.is_open, true);
});

test('garbage string → NOASSERTION (permissive default)', () => {
  const result = normalizeLicense('something completely unknown');
  assert.equal(result.spdx, 'NOASSERTION');
  assert.equal(result.is_open, true);
  assert.equal(result.raw, 'something completely unknown');
});

// ── isOpenLicense helper ──────────────────────────────────────

test('isOpenLicense — known open licenses', () => {
  assert.equal(isOpenLicense('CC0-1.0'), true);
  assert.equal(isOpenLicense('CC-BY-4.0'), true);
  assert.equal(isOpenLicense('CC-BY-SA-4.0'), true);
  assert.equal(isOpenLicense('CC-BY-3.0'), true);
  assert.equal(isOpenLicense('CC-BY-2.0'), true);
});

test('isOpenLicense — known restrictive licenses', () => {
  assert.equal(isOpenLicense('CC-BY-NC-4.0'), false);
  assert.equal(isOpenLicense('CC-BY-NC-SA-4.0'), false);
  assert.equal(isOpenLicense('CC-BY-NC-ND-4.0'), false);
  assert.equal(isOpenLicense('CC-BY-ND-4.0'), false);
  assert.equal(isOpenLicense('LicenseRef-arxiv-nonexclusive'), false);
  assert.equal(isOpenLicense('LicenseRef-arxiv-assumed'), false);
});

test('isOpenLicense — NOASSERTION is open (permissive default)', () => {
  assert.equal(isOpenLicense('NOASSERTION'), true);
});

test('isOpenLicense — unknown LicenseRef defaults to false', () => {
  assert.equal(isOpenLicense('LicenseRef-something-custom'), false);
});

// ── Real-world arXiv samples (from research) ─────────────────

test('real arXiv sample: 47% CC-BY-4.0', () => {
  // Most common license in arXiv cs.AI/cs.CL/cs.LG
  const samples = [
    'http://creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by/4.0/',
  ];
  for (const s of samples) {
    const r = normalizeLicense(s);
    assert.equal(r.spdx, 'CC-BY-4.0', `failed for: ${s}`);
    assert.equal(r.is_open, true);
  }
});

test('real arXiv sample: 43% arxiv-nonexclusive', () => {
  const r = normalizeLicense('http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
  assert.equal(r.spdx, 'LicenseRef-arxiv-nonexclusive');
  assert.equal(r.is_open, false);
});

test('real arXiv sample: 10% CC-BY-NC-ND-4.0', () => {
  const r = normalizeLicense('http://creativecommons.org/licenses/by-nc-nd/4.0/');
  assert.equal(r.spdx, 'CC-BY-NC-ND-4.0');
  assert.equal(r.is_open, false);
});

// ── computeEffectiveLicense ───────────────────────────────────

test('computeEffectiveLicense: empty map → NOASSERTION', () => {
  assert.equal(computeEffectiveLicense({}), 'NOASSERTION');
});

test('computeEffectiveLicense: null → NOASSERTION', () => {
  assert.equal(computeEffectiveLicense(null), 'NOASSERTION');
});

test('computeEffectiveLicense: undefined → NOASSERTION', () => {
  assert.equal(computeEffectiveLicense(undefined), 'NOASSERTION');
});

test('computeEffectiveLicense: single source arxiv_oai', () => {
  assert.equal(
    computeEffectiveLicense({ arxiv_oai: 'CC-BY-4.0' }),
    'CC-BY-4.0',
  );
});

test('computeEffectiveLicense: open license wins over restricted (most permissive)', () => {
  // crossref CC-BY-4.0 (open) wins over arxiv_oai restricted,
  // even though arxiv_oai has higher source priority
  assert.equal(
    computeEffectiveLicense({
      arxiv_oai: 'LicenseRef-arxiv-nonexclusive',
      crossref: 'CC-BY-4.0',
    }),
    'CC-BY-4.0',
  );
});

test('computeEffectiveLicense: open from unpaywall wins over restricted arxiv', () => {
  // Real-world case: arXiv paper with restricted license but published
  // version found by Unpaywall with CC-BY-4.0
  assert.equal(
    computeEffectiveLicense({
      arxiv_oai: 'LicenseRef-arxiv-nonexclusive',
      openalex: 'CC-BY-4.0',
      unpaywall: 'CC-BY-4.0',
    }),
    'CC-BY-4.0',
  );
});

test('computeEffectiveLicense: among open licenses, higher priority wins', () => {
  // Both open — arxiv_oai has higher priority
  assert.equal(
    computeEffectiveLicense({
      arxiv_oai: 'CC-BY-SA-4.0',
      unpaywall: 'CC-BY-4.0',
    }),
    'CC-BY-SA-4.0',
  );
});

test('computeEffectiveLicense: all restricted — highest priority wins', () => {
  assert.equal(
    computeEffectiveLicense({
      arxiv_oai: 'LicenseRef-arxiv-nonexclusive',
      crossref: 'CC-BY-NC-4.0',
    }),
    'LicenseRef-arxiv-nonexclusive',
  );
});

test('computeEffectiveLicense: openarx wins over everything', () => {
  // Documents published via OpenArx Portal have author-selected license that
  // takes priority — author has contractual right to set license
  assert.equal(
    computeEffectiveLicense({
      openarx: 'CC-BY-4.0',
      arxiv_oai: 'LicenseRef-arxiv-nonexclusive',
      crossref: 'LicenseRef-arxiv-nonexclusive',
    }),
    'CC-BY-4.0',
  );
});

test('computeEffectiveLicense: falls through priority order', () => {
  // Skip arxiv_oai (no value), use crossref
  assert.equal(
    computeEffectiveLicense({
      crossref: 'CC-BY-4.0',
      openalex: 'CC-BY-NC-4.0',
    }),
    'CC-BY-4.0',
  );
});

test('computeEffectiveLicense: only openalex', () => {
  assert.equal(
    computeEffectiveLicense({ openalex: 'CC-BY-SA-4.0' }),
    'CC-BY-SA-4.0',
  );
});

test('computeEffectiveLicense: unknown source ignored', () => {
  // 'some_other_source' is not in priority list — falls back to NOASSERTION
  assert.equal(
    computeEffectiveLicense({ some_other_source: 'CC-BY-4.0' }),
    'NOASSERTION',
  );
});

// ── Software licenses (Unpaywall/OpenAlex) ──────────────────

test('mit → MIT', () => {
  const r = normalizeLicense('mit');
  assert.equal(r.spdx, 'MIT');
  assert.equal(r.is_open, true);
});

test('apache-2.0 → Apache-2.0', () => {
  const r = normalizeLicense('apache-2.0');
  assert.equal(r.spdx, 'Apache-2.0');
  assert.equal(r.is_open, true);
});

test('bsd → BSD-3-Clause', () => {
  const r = normalizeLicense('bsd');
  assert.equal(r.spdx, 'BSD-3-Clause');
  assert.equal(r.is_open, true);
});

test('bsd-3-clause → BSD-3-Clause', () => {
  const r = normalizeLicense('bsd-3-clause');
  assert.equal(r.spdx, 'BSD-3-Clause');
  assert.equal(r.is_open, true);
});

// ── Unpaywall/OpenAlex markers (not real licenses) ──────────

test('implied-oa → NOASSERTION (permissive default)', () => {
  const r = normalizeLicense('implied-oa');
  assert.equal(r.spdx, 'NOASSERTION');
  assert.equal(r.is_open, true);
  assert.equal(r.raw, 'implied-oa');
});

test('other-oa → NOASSERTION (permissive default)', () => {
  const r = normalizeLicense('other-oa');
  assert.equal(r.spdx, 'NOASSERTION');
  assert.equal(r.is_open, true);
});

test('pd short form → CC-PDDC', () => {
  const r = normalizeLicense('pd');
  assert.equal(r.spdx, 'CC-PDDC');
  assert.equal(r.is_open, true);
});

// ── isOpenLicense: software licenses ─────────────────────────

test('isOpenLicense: MIT → true', () => {
  assert.equal(isOpenLicense('MIT'), true);
});

test('isOpenLicense: Apache-2.0 → true', () => {
  assert.equal(isOpenLicense('Apache-2.0'), true);
});

test('isOpenLicense: BSD-3-Clause → true', () => {
  assert.equal(isOpenLicense('BSD-3-Clause'), true);
});

test('isOpenLicense: CC-PDDC → true', () => {
  assert.equal(isOpenLicense('CC-PDDC'), true);
});

// ── computeEffectiveLicense: core source ─────────────────────

test('computeEffectiveLicense: core source recognized', () => {
  assert.equal(
    computeEffectiveLicense({ core: 'CC-BY-4.0' }),
    'CC-BY-4.0',
  );
});

test('computeEffectiveLicense: core lower priority than openalex', () => {
  assert.equal(
    computeEffectiveLicense({ openalex: 'CC-BY-SA-4.0', core: 'CC-BY-4.0' }),
    'CC-BY-SA-4.0',
  );
});
