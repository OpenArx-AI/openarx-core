/**
 * Unit tests for buildEmbedText — single source of truth for embed input.
 * Same formula must be used by ingest workers and the metadata-backfill
 * script so re-embedded chunks have geometry consistent with fresh ingests.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Chunk } from '@openarx/types';
import { buildEmbedText } from '../embed-text-builder.js';

function makeChunk(overrides: Partial<Chunk['context']> & { content?: string }): Chunk {
  const { content = 'chunk body text', ...ctx } = overrides;
  return {
    id: 'c1',
    documentId: 'd1',
    version: 1,
    content,
    context: {
      documentTitle: 'Attention Is All You Need',
      sectionName: 'Methods',
      sectionPath: 'Methods > Attention',
      positionInDocument: 0,
      totalChunks: 1,
      ...ctx,
    } as Chunk['context'],
    vectors: { gemini: [], specter2: [] },
    metrics: {},
    createdAt: new Date(),
  } as Chunk;
}

test('full path: title + section + [keyConcept] summary + content when both markers present', () => {
  const chunk = makeChunk({
    summary: 'Self-attention computes weighted sums over input positions.',
    keyConcept: 'self-attention mechanism',
    content: 'The self-attention mechanism allows the model to attend over all positions.',
  });
  const text = buildEmbedText(chunk);
  assert.equal(
    text,
    'Attention Is All You Need. Methods > Attention. [self-attention mechanism] Self-attention computes weighted sums over input positions.\nThe self-attention mechanism allows the model to attend over all positions.',
  );
});

test('fallback path: title + section + content when summary missing', () => {
  const chunk = makeChunk({ summary: undefined, keyConcept: 'foo' });
  const text = buildEmbedText(chunk);
  assert.equal(text, 'Attention Is All You Need. Methods > Attention. chunk body text');
});

test('fallback path: title + section + content when keyConcept missing', () => {
  const chunk = makeChunk({ summary: 'a sentence', keyConcept: undefined });
  const text = buildEmbedText(chunk);
  assert.equal(text, 'Attention Is All You Need. Methods > Attention. chunk body text');
});

test('falls back to sectionName when sectionPath absent', () => {
  const chunk = makeChunk({ sectionPath: undefined });
  const text = buildEmbedText(chunk);
  assert.equal(text, 'Attention Is All You Need. Methods. chunk body text');
});

test('handles empty title gracefully', () => {
  const chunk = makeChunk({ documentTitle: '' });
  const text = buildEmbedText(chunk);
  assert.equal(text, '. Methods > Attention. chunk body text');
});
