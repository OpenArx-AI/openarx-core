/**
 * TDD tests for resolveInputs behaviour in latex-parser.ts.
 *
 * Covers two bugs surfaced by the parser-test-corpus diagnostic
 * (experiments/parser-test-corpus, 2026-05-02):
 *
 *   Bug 1: commented-out `\input{}` lines were matched as real includes.
 *          Inkscape's `.pdf_tex` shim files embed the line
 *            %%   \input{<filename>.pdf_tex}
 *          as a usage hint. Each figure inflated missing_body by ~1.
 *
 *   Bug 2: graphics paths (.pdf_tex, .pdf, .svg, .eps, .png, .jpg) were
 *          counted toward missing_body when their files were absent
 *          (typical: pdf_tex is generated at build-time). Graphics are
 *          not body content and must be excluded.
 *
 * Run: pnpm --filter @openarx/ingest test:resolve-inputs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLatexSource, maskLatexComments } from '../latex-parser.js';
import { isBodyInclude } from '../include-filter.js';

describe('maskLatexComments', () => {
  it('replaces a line-leading comment with same-length whitespace', () => {
    const input = '%   \\input{foo.pdf_tex}\nReal text';
    const out = maskLatexComments(input);
    assert.equal(out.length, input.length, 'length preserved');
    assert.match(out, /^\s+\nReal text$/, 'comment line is whitespace');
    assert.ok(!/\\input/.test(out.split('\n')[0]), 'no \\input survives in masked first line');
  });

  it('preserves \\% (escaped percent) — not a comment', () => {
    const input = 'Discount of 30\\% applied here';
    assert.equal(maskLatexComments(input), input, 'escaped percent untouched');
  });

  it('masks mid-line comments only after the unescaped %', () => {
    const input = 'Real text % then a comment\nNext line';
    const out = maskLatexComments(input);
    assert.equal(out.length, input.length);
    assert.ok(out.startsWith('Real text '), 'prefix preserved');
    assert.ok(!out.includes('comment'), 'comment masked');
    assert.ok(out.includes('Next line'), 'next line untouched');
  });
});

describe('isBodyInclude — graphics extensions (Bug 2)', () => {
  const graphicsExt = ['pdf_tex', 'pdf', 'svg', 'eps', 'ps', 'png', 'jpg', 'jpeg', 'gif'];
  for (const ext of graphicsExt) {
    it(`treats *.${ext} as non-body`, () => {
      assert.equal(isBodyInclude(`figures/teaser.${ext}`), false, `figures/teaser.${ext} should be non-body`);
      assert.equal(isBodyInclude(`teaser.${ext}`), false, `bare teaser.${ext} should be non-body`);
    });
  }
  it('still treats .tex section files as body', () => {
    assert.equal(isBodyInclude('sections/intro'), true);
    assert.equal(isBodyInclude('sections/intro.tex'), true);
  });
});

describe('parseLatexSource — Bug 1 (commented-out \\input)', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'latex-parser-bug1-'));
    // root.tex with both real and commented \input
    writeFileSync(join(dir, 'main.tex'), [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\input{intro}',                           // real
      '%% Inkscape header:',
      '%%   \\input{<filename>.pdf_tex}',         // commented — must NOT count as missing
      '%   \\input{never-existed-commented}',     // commented — must NOT count
      '\\input{conclusion}',                      // real, will be missing (file absent)
      '\\end{document}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'intro.tex'), '\\section{Introduction}\nIntro body.\n');
    // conclusion.tex deliberately absent — only this should appear in missing
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not record commented-out \\input as missing', async () => {
    const parsed = await parseLatexSource(dir, 'main.tex');
    const missing = parsed.stats?.missingIncludes ?? [];
    // Should contain the one real missing file (paths may be absolute —
    // resolveInputs propagates from probe[]; quality-metrics later filters
    // via basename-aware isBodyInclude).
    assert.ok(
      missing.some((m) => m.endsWith('conclusion') || m.endsWith('conclusion.tex')),
      `expected a 'conclusion' miss, got: ${JSON.stringify(missing)}`
    );
    // Must NOT include the commented-out entries
    assert.ok(
      !missing.some((m) => m.includes('<filename>.pdf_tex') || m.includes('never-existed-commented')),
      `commented-out \\input must not appear in missing; got: ${JSON.stringify(missing)}`
    );
    // And must not pick up any pdf_tex entry from the comment
    assert.ok(
      !missing.some((m) => m.endsWith('.pdf_tex')),
      `commented .pdf_tex must not appear in missing; got: ${JSON.stringify(missing)}`
    );
  });
});

describe('parseLatexSource — Bug 2 (graphics extensions)', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'latex-parser-bug2-'));
    writeFileSync(join(dir, 'main.tex'), [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\input{teaser.pdf_tex}',         // graphic — absent, must NOT count as body-missing
      '\\input{plot/figure-1.pdf_tex}',  // graphic — absent, must NOT count
      '\\input{photo.png}',              // raw raster — absent, must NOT count
      '\\input{lost-section}',           // real body — absent, MUST count
      '\\end{document}',
      '',
    ].join('\n'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('graphics-extension misses are filtered out of missing_body via isBodyInclude', async () => {
    const parsed = await parseLatexSource(dir, 'main.tex');
    const missingAll = parsed.stats?.missingIncludes ?? [];
    const missingBody = missingAll.filter(isBodyInclude);
    assert.ok(
      missingBody.some((m) => m.endsWith('lost-section') || m.endsWith('lost-section.tex')),
      `body-missing should include 'lost-section', got: ${JSON.stringify(missingBody)}`
    );
    assert.ok(
      !missingBody.some((m) => /\.(pdf_tex|png|svg|pdf|eps|jpg)$/i.test(m)),
      `graphics must not appear in missingBody; got: ${JSON.stringify(missingBody)}`
    );
    assert.equal(missingBody.length, 1, `expected exactly 1 body-missing (lost-section), got ${missingBody.length}: ${JSON.stringify(missingBody)}`);
  });
});
