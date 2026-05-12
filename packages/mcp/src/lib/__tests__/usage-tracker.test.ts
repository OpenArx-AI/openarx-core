/**
 * TDD tests for UsageTracker — pure aggregation of LLM/embed call records.
 *
 * Run: pnpm --filter @openarx/mcp test:usage-tracker
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker, EMPTY_USAGE_SNAPSHOT } from '../usage-tracker.js';
import type { ModelResponse, EmbedResponse } from '@openarx/types';

const llmResp = (overrides: Partial<ModelResponse> = {}): ModelResponse => ({
  text: 'mock',
  model: 'gemini-2.0-flash',
  provider: 'vertex',
  inputTokens: 100,
  outputTokens: 50,
  cost: 0.0002,
  ...overrides,
});

const embedResp = (overrides: Partial<EmbedResponse> = {}): EmbedResponse => ({
  vectors: [[0.1, 0.2]],
  dimensions: 2,
  model: 'text-embedding-004',
  provider: 'vertex',
  inputTokens: 10,
  cost: 0.00001,
  ...overrides,
});

describe('UsageTracker.snapshot — empty', () => {
  test('returns null arrays + zero totals when no calls recorded', () => {
    const t = new UsageTracker();
    const s = t.snapshot();
    assert.equal(s.llmCalls, null);
    assert.equal(s.embedCalls, null);
    assert.equal(s.llmCostUsdTotal, 0);
    assert.equal(s.embedCostUsdTotal, 0);
    assert.equal(s.llmInputTokensTotal, 0);
    assert.equal(s.llmOutputTokensTotal, 0);
  });

  test('EMPTY_USAGE_SNAPSHOT matches new tracker shape', () => {
    const fresh = new UsageTracker().snapshot();
    assert.deepEqual(fresh, EMPTY_USAGE_SNAPSHOT);
  });
});

describe('UsageTracker.recordLlm', () => {
  test('captures task, provider, model, tokens, cost', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp(), 'enrichment');
    const s = t.snapshot();
    assert.equal(s.llmCalls?.length, 1);
    assert.deepEqual(s.llmCalls?.[0], {
      task: 'enrichment',
      provider: 'vertex',
      model: 'gemini-2.0-flash',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0002,
    });
  });

  test('aggregates totals across multiple calls', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp({ inputTokens: 100, outputTokens: 50, cost: 0.0002 }), 'enrichment');
    t.recordLlm(llmResp({ inputTokens: 150, outputTokens: 75, cost: 0.0003 }), 'enrichment');
    t.recordLlm(llmResp({ inputTokens: 200, outputTokens: 100, cost: 0.0005 }), 'translation');
    const s = t.snapshot();
    assert.equal(s.llmCalls?.length, 3);
    assert.equal(s.llmInputTokensTotal, 450);
    assert.equal(s.llmOutputTokensTotal, 225);
    assert.ok(Math.abs(s.llmCostUsdTotal - 0.001) < 1e-9);
  });

  test('handles missing tokens/cost defensively', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp({ inputTokens: 0, outputTokens: 0, cost: 0 }), 'enrichment');
    const s = t.snapshot();
    assert.equal(s.llmInputTokensTotal, 0);
    assert.equal(s.llmCostUsdTotal, 0);
    assert.equal(s.llmCalls?.length, 1);
  });

  test('captures finishReason when present', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp({ finishReason: 'STOP' }), 'enrichment');
    assert.equal(t.snapshot().llmCalls?.[0].finishReason, 'STOP');
  });

  test('omits finishReason field when not provided', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp(), 'enrichment');
    assert.equal('finishReason' in (t.snapshot().llmCalls![0]), false);
  });

  test('preserves order of records', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp({ model: 'first' }), 'enrichment');
    t.recordLlm(llmResp({ model: 'second' }), 'enrichment');
    t.recordLlm(llmResp({ model: 'third' }), 'enrichment');
    const s = t.snapshot();
    assert.equal(s.llmCalls?.[0].model, 'first');
    assert.equal(s.llmCalls?.[1].model, 'second');
    assert.equal(s.llmCalls?.[2].model, 'third');
  });

  test('falls back to "unknown" provider when not set', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp({ provider: undefined }), 'enrichment');
    assert.equal(t.snapshot().llmCalls?.[0].provider, 'unknown');
  });
});

describe('UsageTracker.recordEmbed', () => {
  test('captures provider, model, tokens, cost', () => {
    const t = new UsageTracker();
    t.recordEmbed(embedResp());
    const s = t.snapshot();
    assert.equal(s.embedCalls?.length, 1);
    assert.deepEqual(s.embedCalls?.[0], {
      provider: 'vertex',
      model: 'text-embedding-004',
      inputTokens: 10,
      costUsd: 0.00001,
    });
  });

  test('aggregates embed totals', () => {
    const t = new UsageTracker();
    t.recordEmbed(embedResp({ cost: 0.00001 }));
    t.recordEmbed(embedResp({ cost: 0.00002 }));
    t.recordEmbed(embedResp({ cost: 0.00003 }));
    const s = t.snapshot();
    assert.equal(s.embedCalls?.length, 3);
    assert.ok(Math.abs(s.embedCostUsdTotal - 0.00006) < 1e-12);
  });
});

describe('UsageTracker — mixed LLM + embed', () => {
  test('llm and embed totals are independent', () => {
    const t = new UsageTracker();
    t.recordEmbed(embedResp({ cost: 0.0001, inputTokens: 5 }));
    t.recordLlm(llmResp({ cost: 0.002, inputTokens: 100, outputTokens: 50 }), 'enrichment');
    t.recordEmbed(embedResp({ cost: 0.0002, inputTokens: 15 }));
    const s = t.snapshot();
    assert.equal(s.llmCalls?.length, 1);
    assert.equal(s.embedCalls?.length, 2);
    assert.ok(Math.abs(s.llmCostUsdTotal - 0.002) < 1e-9);
    assert.ok(Math.abs(s.embedCostUsdTotal - 0.0003) < 1e-9);
    // llm token totals should NOT include embed inputTokens
    assert.equal(s.llmInputTokensTotal, 100);
    assert.equal(s.llmOutputTokensTotal, 50);
  });
});

describe('UsageTracker.snapshot — immutability', () => {
  test('snapshot arrays are shallow copies — mutating snapshot does not affect tracker', () => {
    const t = new UsageTracker();
    t.recordLlm(llmResp(), 'enrichment');
    const s1 = t.snapshot();
    s1.llmCalls?.push({
      task: 'mutation',
      provider: 'evil',
      model: 'evil',
      inputTokens: 999,
      outputTokens: 999,
      costUsd: 999,
    });
    const s2 = t.snapshot();
    assert.equal(s2.llmCalls?.length, 1);
    assert.equal(s2.llmCalls?.[0].task, 'enrichment');
  });
});
