/**
 * Tests for markdown-parser — covers both Mathpix output (existing
 * shape) and direct Portal .md submissions (new path).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseMarkdown } from '../markdown-parser.js';

test('parseMarkdown: extracts title from first H1', () => {
  const md = `# My Paper Title\n\n## Introduction\n\nBody.\n`;
  const parsed = parseMarkdown(md);
  assert.equal(parsed.title, 'My Paper Title');
});

test('parseMarkdown: extracts abstract section content', () => {
  const md = `# Title\n\n## Abstract\n\nThis is the abstract text.\n\n## Introduction\n\nIntro.`;
  const parsed = parseMarkdown(md);
  assert.equal(parsed.abstract, 'This is the abstract text.');
});

test('parseMarkdown: builds top-level sections', () => {
  const md = `# Title\n\n## Introduction\n\nIntro body.\n\n## Method\n\nMethod body.\n\n## Conclusion\n\nDone.`;
  const parsed = parseMarkdown(md);
  // Title, abstract aside — sections include Introduction, Method, Conclusion
  const names = parsed.sections.map((s) => s.name);
  assert.deepEqual(names, ['Introduction', 'Method', 'Conclusion']);
});

test('parseMarkdown: nests sub-sections under numbered parents', () => {
  const md = [
    '# Title',
    '## 3 Method',
    'Method intro.',
    '## 3.1 Subsection A',
    'Sub A body.',
    '## 3.2 Subsection B',
    'Sub B body.',
    '## 4 Results',
    'Results body.',
  ].join('\n');
  const parsed = parseMarkdown(md);
  assert.equal(parsed.sections.length, 2, 'two top-level sections (Method, Results)');
  const method = parsed.sections[0];
  assert.equal(method.name, 'Method');
  assert.equal(method.subsections?.length, 2);
  assert.equal(method.subsections?.[0].name, 'Subsection A');
});

test('parseMarkdown: extracts $$ display formulas', () => {
  const md = `# Title\n\n## Method\n\nFormula:\n\n$$E = mc^2 \\quad (1)$$\n\nMore:\n\n$$\\sum x_i$$\n`;
  const parsed = parseMarkdown(md);
  assert.equal(parsed.formulas.length, 2);
  assert.equal(parsed.formulas[0].raw, 'E = mc^2 \\quad (1)');
  assert.equal(parsed.formulas[0].label, '1', 'numbered formula label captured');
});

test('parseMarkdown: extracts references from References section', () => {
  const md = [
    '# Title',
    '## Introduction',
    'Body.',
    '## References',
    'Vaswani et al. 2017. Attention is all you need. NeurIPS.',
    '',
    'Lewis et al. 2020. BART: Denoising sequence-to-sequence pre-training.',
  ].join('\n');
  const parsed = parseMarkdown(md);
  assert.equal(parsed.references.length, 2);
  assert.match(parsed.references[0].raw, /Vaswani/);
});

test('parseMarkdown: parserUsed defaults to "markdown" for direct submissions', () => {
  const parsed = parseMarkdown(`# T\n\n## A\nbody`);
  assert.equal(parsed.parserUsed, 'markdown');
});

test('parseMarkdown: parserUsed honoured when set (mathpix path)', () => {
  const parsed = parseMarkdown(`# T\n\n## A\nbody`, { parserUsed: 'mathpix', parseDurationMs: 42 });
  assert.equal(parsed.parserUsed, 'mathpix');
  assert.equal(parsed.parseDurationMs, 42);
});

test('parseMarkdown: empty input → empty document', () => {
  const parsed = parseMarkdown('');
  assert.equal(parsed.title, '');
  assert.equal(parsed.sections.length, 0);
  assert.equal(parsed.references.length, 0);
  assert.equal(parsed.formulas.length, 0);
});

test('parseMarkdown: markdown without H1 still works (no title)', () => {
  const md = `## Introduction\n\nNo title heading.\n`;
  const parsed = parseMarkdown(md);
  assert.equal(parsed.title, '');
  assert.equal(parsed.sections[0].name, 'Introduction');
});

test('parseMarkdown: HTML tags stripped from heading text', () => {
  const md = `# Title <br/> with <em>tags</em>\n\n## Body\nx`;
  const parsed = parseMarkdown(md);
  // Tags removed, but adjacent whitespace can collapse to multiple spaces — fine
  assert.match(parsed.title, /^Title\s+with tags$/);
});
