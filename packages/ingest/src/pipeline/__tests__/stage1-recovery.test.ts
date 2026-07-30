import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedSection } from '@openarx/types';
import { reconstructAndRecover, type DocChunk } from '../stage1-recovery.js';

const sec = (name: string, content: string): ParsedSection =>
  ({ name, content, level: 1, subsections: [] } as unknown as ParsedSection);

test('reconstructAndRecover: multi-section batch — per-batch recovery to exact source', () => {
  // Two small sections → one batch (both < BATCH_CHAR_LIMIT).
  const sections = [
    sec('S1', 'The alpha result is $5\\%$ better on the test set.'),
    sec('S2', 'We conclude beta improves accuracy by ten points overall here.'),
  ];
  const chunks: Array<DocChunk & { id: string }> = [
    // S1 chunk, LaTeX-normalized by the model → recover the exact source
    { id: 'c1', content: 'The alpha result is 5% better on the test set.', sectionPath: 'S1', position: 0 },
    // S2 chunk, verbatim
    { id: 'c2', content: 'We conclude beta improves accuracy by ten points overall here.', sectionPath: 'S2', position: 1 },
  ];
  const out = reconstructAndRecover(sections, chunks);
  assert.equal(out.length, 2);
  assert.equal(out[0].result.status, 'recovered');
  assert.equal(out[0].result.text, 'The alpha result is $5\\%$ better on the test set.');
  assert.equal(out[1].result.status, 'recovered');
  assert.equal(out[1].result.text, 'We conclude beta improves accuracy by ten points overall here.');
});

test('reconstructAndRecover: chunk with unknown section → FAILED (never silent), original order preserved', () => {
  const sections = [sec('Intro', 'This introduction sets up the problem statement clearly and in full.')];
  const chunks: Array<DocChunk & { id: string }> = [
    { id: 'bad', content: 'text from a section that does not exist', sectionPath: 'Ghost', position: 5 },
    { id: 'good', content: 'This introduction sets up the problem statement clearly and in full.', sectionPath: 'Intro', position: 0 },
  ];
  const out = reconstructAndRecover(sections, chunks);
  // returned in input order
  assert.equal(out[0].chunk.id, 'bad');
  assert.equal(out[0].result.status, 'FAILED');
  assert.equal(out[0].result.method, 'unmatched-section');
  assert.equal(out[1].chunk.id, 'good');
  assert.equal(out[1].result.status, 'recovered');
});

test('reconstructAndRecover: matches a "---SECTION: … ---" wrapped label (strip + exact)', () => {
  const sections = [sec('RLHF', 'The RLHF procedure aligns the model using human preference data extensively here.')];
  const chunks: Array<DocChunk & { id: string }> = [
    { id: 'w', content: 'The RLHF procedure aligns the model using human preference data extensively here.', sectionPath: '---SECTION: RLHF---', position: 0 },
  ];
  const out = reconstructAndRecover(sections, chunks);
  assert.equal(out[0].result.status, 'recovered');
});

test('reconstructAndRecover: hierarchical chunk label matches a flat stored section by leaf', () => {
  const sections = [sec('Reinforcement Learning with Human Feedback (RLHF)', 'We collect human preference data and train a reward model on it in this section.')];
  const chunks: Array<DocChunk & { id: string }> = [
    { id: 'h', content: 'We collect human preference data and train a reward model on it in this section.', sectionPath: 'Fine-tuning > Reinforcement Learning with Human Feedback (RLHF)', position: 0 },
  ];
  const out = reconstructAndRecover(sections, chunks);
  assert.equal(out[0].result.status, 'recovered');
});
