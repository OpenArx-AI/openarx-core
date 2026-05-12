import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildEmbedInput,
  splitBatches,
  type MigrationChunkRow,
} from '../migrate-embeddings-lib.js';

// ─── buildEmbedInput — must match packages/ingest/src/pipeline/workers.ts ──

test('buildEmbedInput: enriched format (title + section + keyConcept + summary + content)', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'The content body here.',
    context: {
      documentTitle: 'Attention Is All You Need',
      sectionPath: 'Introduction > Motivation',
      summary: 'Introduces the transformer architecture replacing RNNs.',
      keyConcept: 'self-attention',
    },
  };
  const expected =
    'Attention Is All You Need. Introduction > Motivation. [self-attention] ' +
    'Introduces the transformer architecture replacing RNNs.\nThe content body here.';
  assert.equal(buildEmbedInput(row), expected);
});

test('buildEmbedInput: short format (no summary/keyConcept)', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'Body.',
    context: {
      documentTitle: 'Doc Title',
      sectionPath: 'Sec 1',
    },
  };
  assert.equal(buildEmbedInput(row), 'Doc Title. Sec 1. Body.');
});

test('buildEmbedInput: sectionName fallback when sectionPath missing', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'body',
    context: {
      documentTitle: 'T',
      sectionName: 'Only Name',
    },
  };
  assert.equal(buildEmbedInput(row), 'T. Only Name. body');
});

test('buildEmbedInput: sectionPath takes precedence over sectionName', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'body',
    context: {
      documentTitle: 'T',
      sectionPath: 'Path',
      sectionName: 'Name',
    },
  };
  assert.equal(buildEmbedInput(row), 'T. Path. body');
});

test('buildEmbedInput: missing title → empty prefix', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'body',
    context: { sectionPath: 'S' },
  };
  assert.equal(buildEmbedInput(row), '. S. body');
});

test('buildEmbedInput: empty context', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'body',
    context: {},
  };
  assert.equal(buildEmbedInput(row), '. . body');
});

test('buildEmbedInput: only summary without keyConcept → short format', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'body',
    context: {
      documentTitle: 'T',
      sectionPath: 'S',
      summary: 'has summary',
      // no keyConcept → should take short path
    },
  };
  assert.equal(buildEmbedInput(row), 'T. S. body');
});

test('buildEmbedInput: only keyConcept without summary → short format', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'body',
    context: {
      documentTitle: 'T',
      sectionPath: 'S',
      keyConcept: 'kc',
      // no summary → short
    },
  };
  assert.equal(buildEmbedInput(row), 'T. S. body');
});

test('buildEmbedInput: newline between summary and content in enriched format', () => {
  const row: MigrationChunkRow = {
    id: 'x',
    qdrant_point_id: 'p',
    content: 'line1\nline2',
    context: {
      documentTitle: 'T',
      sectionPath: 'S',
      keyConcept: 'kc',
      summary: 'sum',
    },
  };
  const out = buildEmbedInput(row);
  assert.ok(out.includes('sum\nline1\nline2'), out);
});

// ─── splitBatches ─────────────────────────────────────────────

test('splitBatches: even split', () => {
  assert.deepEqual(splitBatches([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('splitBatches: uneven last batch', () => {
  assert.deepEqual(splitBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('splitBatches: size larger than array', () => {
  assert.deepEqual(splitBatches([1, 2], 10), [[1, 2]]);
});

test('splitBatches: empty array', () => {
  assert.deepEqual(splitBatches([], 5), []);
});
