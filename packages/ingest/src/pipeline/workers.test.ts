/**
 * Pre-parse source-availability path resolution (openarx-zcsi / w7um regression).
 * The bug: portal markdown/latex docs store the canonical artifact at {dir}/eprint
 * with a LAZY {dir}/source pointer, but the guard only checked the (nonexistent)
 * source path → false → arXiv re-download → fail. The fix includes the eprint
 * sibling as an availability signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Document, ParsedSection } from '@openarx/types';
import { sourceCheckPaths, sectionsToText } from './workers.js';

test('sourceCheckPaths: pdf → just the pdf file (no eprint)', () => {
  const s = { pdf: { path: '/d/paper.pdf', size: 10 } } as Document['sources'];
  assert.deepEqual(sourceCheckPaths(s), ['/d/paper.pdf']);
});

test('sourceCheckPaths: w7um markdown lazy source → source dir + eprint sibling (the fix)', () => {
  const s = { markdown: { path: '/d/source', rootMd: 'main.md' } } as Document['sources'];
  assert.deepEqual(sourceCheckPaths(s), ['/d/source', '/d/eprint']);
});

test('sourceCheckPaths: w7um latex lazy source → source dir + eprint sibling', () => {
  const s = { latex: { path: '/d/source', rootTex: 'main.tex', manifest: false, texFiles: 1 } } as Document['sources'];
  assert.deepEqual(sourceCheckPaths(s), ['/d/source', '/d/eprint']);
});

test('sourceCheckPaths: grandfathered direct .md → the .md plus an (absent) eprint probe', () => {
  const s = { markdown: { path: '/d/paper.md' } } as Document['sources'];
  assert.deepEqual(sourceCheckPaths(s), ['/d/paper.md', '/d/eprint']);
});

test('sourceCheckPaths: no sources, rawContentPath only', () => {
  assert.deepEqual(sourceCheckPaths(undefined, '/d/raw.pdf'), ['/d/raw.pdf']);
});

test('sourceCheckPaths: nothing → empty list', () => {
  assert.deepEqual(sourceCheckPaths(undefined), []);
});

// ── openarx-9sps: cited ids in the References section must reach extraction ──
test('sectionsToText flattens nested sections incl. a References section', () => {
  const sections: ParsedSection[] = [
    { name: 'Introduction', content: 'We build on prior work.', level: 1 },
    {
      name: 'References',
      content: '[1] Venkataraman. oarx-a368071ed583d430, 2026.',
      level: 1,
      subsections: [{ name: 'cont', content: 'arXiv: 2305.09999', level: 2 }],
    },
  ];
  const text = sectionsToText(sections);
  // The References-section oarx_id + a nested arXiv id are present — i.e. they
  // reach extractIdentifiersFromText even though the chunker would drop them.
  assert.match(text, /oarx-a368071ed583d430/);
  assert.match(text, /2305\.09999/);
  assert.match(text, /Introduction/);
});
