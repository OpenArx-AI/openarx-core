/**
 * Tests for the lazy-extraction detection helpers (openarx-yvkp).
 *
 * detectLatexFromTarListing decides whether an eprint archive is a LaTeX
 * source bundle and surfaces the manifest+texCount counts WITHOUT
 * extracting it to disk. The pure-function shape lets us unit-test the
 * classification logic against representative arXiv archive layouts.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectLatexFromTarListing } from '../arxiv-source.js';

test('typical arXiv LaTeX archive (root-level .tex + manifest)', () => {
  const filenames = [
    '00README.json',
    'main.tex',
    'main.bbl',
    'figures/fig1.pdf',
    'figures/fig2.pdf',
  ];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.isLatex, true);
  assert.equal(r.texFiles, 1);
  assert.equal(r.hasManifest, true);
});

test('ICML-style archive with style files + multiple tex', () => {
  const filenames = [
    '00README.json',
    'main.tex',
    'icml2026.sty',
    'icml2026.bst',
    'algorithmic.sty',
    'example_paper.bib',
    'fig/diagram.pdf',
  ];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.isLatex, true);
  assert.equal(r.texFiles, 1);
  assert.equal(r.hasManifest, true);
});

test('no manifest (older arXiv submissions)', () => {
  const filenames = ['paper.tex', 'fig1.eps', 'fig2.eps', 'refs.bib'];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.isLatex, true);
  assert.equal(r.texFiles, 1);
  assert.equal(r.hasManifest, false);
});

test('multi-tex archive (book-style)', () => {
  const filenames = [
    'main.tex',
    'chapter1.tex',
    'chapter2.tex',
    'chapter3.tex',
    'refs.bib',
  ];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.isLatex, true);
  assert.equal(r.texFiles, 4);
});

test('no .tex files → not a LaTeX archive', () => {
  const filenames = ['paper.pdf', 'data.zip', 'README.txt'];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.isLatex, false);
  assert.equal(r.texFiles, 0);
  assert.equal(r.hasManifest, false);
});

test('empty archive listing', () => {
  const r = detectLatexFromTarListing([]);
  assert.equal(r.isLatex, false);
  assert.equal(r.texFiles, 0);
  assert.equal(r.hasManifest, false);
});

test('manifest nested under a subdirectory still counts', () => {
  const filenames = ['paper/00README.json', 'paper/main.tex'];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.hasManifest, true);
  assert.equal(r.texFiles, 1);
});

test('case-insensitive .tex extension match', () => {
  const filenames = ['main.TEX', 'helper.Tex'];
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.texFiles, 2);
});

test('does not count files merely containing ".tex" mid-name', () => {
  const filenames = ['notes.text', 'paper.tex.bak', 'main.tex'];
  // Only `main.tex` ends with `.tex` — `.text` and `.tex.bak` don't.
  const r = detectLatexFromTarListing(filenames);
  assert.equal(r.texFiles, 1);
});
