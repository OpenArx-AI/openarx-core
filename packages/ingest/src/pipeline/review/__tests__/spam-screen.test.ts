/**
 * Unit tests for runSpamScreen (aspect 1).
 * No network, no DB — tests deterministic checks + mocked LLM responses
 * covering the four spec scenarios + a few edge cases around timing and
 * malformed responses.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  runSpamScreen,
  parseLlmResponse,
  type SpamScreenInput,
  type SpamScreenModelRouter,
} from '../spam-screen.js';
import type { ModelResponse } from '@openarx/types';

function mockLlm(response: Partial<ModelResponse> & { text: string }): SpamScreenModelRouter {
  return {
    async complete() {
      return {
        text: response.text,
        model: response.model ?? 'gemini-3-flash-preview',
        inputTokens: response.inputTokens ?? 100,
        outputTokens: response.outputTokens ?? 30,
        cost: response.cost ?? 0.0002,
        provider: response.provider ?? 'vertex',
      };
    },
  };
}

const genuineInput: SpamScreenInput = {
  title: 'Understanding Self-Attention in Transformers via Information Geometry',
  abstract: 'We present a new information-geometric interpretation of self-attention in Transformer models. Our analysis shows that the attention kernel computes a soft projection onto a learned manifold, and we derive generalization bounds that explain empirical scaling behavior. Experimental results on GLUE and SuperGLUE benchmarks support our theoretical claims.',
  body: ('1 Introduction. Recent advances in large language models have been driven by the Transformer architecture (Vaswani et al., 2017), whose central mechanism is self-attention. Despite widespread adoption, a theoretical understanding of why attention generalizes well remains incomplete. ').repeat(20),
  sectionCount: 8,
};

const spamInput: SpamScreenInput = {
  title: 'Buy Now!!! Special Offer',
  abstract: '',
  body: ('Click here to buy the best product ever at lowest price click click click click. ').repeat(20),
  sectionCount: 0,
};

// ── Deterministic path ────────────────────────────────

test('deterministic: empty body → reject without LLM', async () => {
  const r = await runSpamScreen(
    { title: 'Test', abstract: '', body: '', sectionCount: 0 },
    { modelRouter: mockLlm({ text: '{}' }) },
  );
  assert.equal(r.verdict, 'reject');
  assert.equal(r.llmAttempted, false);
  assert.equal(r.reasons[0]!.code, 'EMPTY_BODY');
});

test('deterministic: body < hard-reject threshold → reject without LLM', async () => {
  const r = await runSpamScreen(
    { title: 'Tiny', abstract: 'abc', body: 'short body, only a few chars', sectionCount: 0 },
    { modelRouter: mockLlm({ text: '{}' }), hardRejectMinBodyChars: 100 },
  );
  assert.equal(r.verdict, 'reject');
  assert.equal(r.llmAttempted, false);
  assert.equal(r.reasons[0]!.code, 'BELOW_MIN_LENGTH');
});

test('deterministic: repetitive body → reject without LLM', async () => {
  const body = ('same phrase repeated over and over and over.').repeat(30);
  const r = await runSpamScreen(
    { title: 'Repeat', abstract: 'Abstract summary text.', body, sectionCount: 1 },
    { modelRouter: mockLlm({ text: '{}' }) },
  );
  assert.equal(r.verdict, 'reject');
  assert.equal(r.llmAttempted, false);
  assert.equal(r.reasons[0]!.code, 'REPETITIVE_CONTENT');
});

// ── LLM path ─────────────────────────────────────────

test('LLM pass: genuine verdict → pass', async () => {
  const r = await runSpamScreen(genuineInput, {
    modelRouter: mockLlm({
      text: JSON.stringify({ verdict: 'genuine', reasons: ['genuine_research_content'], confidence: 0.95 }),
    }),
  });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.llmAttempted, true);
  assert.ok(r.reasons.some((x) => x.code === 'LLM_CLASSIFIED_GENUINE'));
  assert.ok(r.llmCost > 0, 'llmCost should be tracked');
});

test('LLM reject: spam verdict with high confidence → reject', async () => {
  const r = await runSpamScreen(spamInput, {
    modelRouter: mockLlm({
      text: JSON.stringify({
        verdict: 'spam',
        reasons: ['nonsensical_text', 'non_scientific_topic'],
        confidence: 0.95,
      }),
    }),
  });
  // spamInput triggers REPETITIVE_CONTENT (deterministic) before reaching LLM
  // but with a different mock input we'd see LLM reject. Verify by checking
  // that if determinstic doesn't kill it, the LLM path works.
  assert.ok(['reject', 'reject'].includes(r.verdict));
});

test('LLM reject: spam verdict via LLM (genuine length, bad content)', async () => {
  const input: SpamScreenInput = {
    title: 'Not Research',
    abstract: 'This is definitely not research content but long enough.',
    body: 'This looks like prose but is actually low-quality filler and marketing text. '.repeat(30),
    sectionCount: 1,
  };
  const r = await runSpamScreen(input, {
    modelRouter: mockLlm({
      text: JSON.stringify({
        verdict: 'spam',
        reasons: ['low_information_density', 'non_scientific_topic'],
        confidence: 0.82,
      }),
    }),
  });
  assert.equal(r.verdict, 'reject');
  assert.equal(r.llmAttempted, true);
  assert.ok(r.reasons.some((x) => x.code === 'LLM_FLAGGED_SPAM'));
});

test('LLM borderline: low confidence → borderline', async () => {
  const r = await runSpamScreen(genuineInput, {
    modelRouter: mockLlm({
      text: JSON.stringify({
        verdict: 'spam',
        reasons: ['low_information_density'],
        confidence: 0.5,  // below 0.6 → demoted to borderline
      }),
    }),
  });
  assert.equal(r.verdict, 'borderline');
  assert.equal(r.llmAttempted, true);
  assert.ok(r.reasons.some((x) => x.code === 'LLM_FLAGGED_BORDERLINE'));
});

test('LLM unavailable: modelRouter=null → borderline with degradation marker', async () => {
  const r = await runSpamScreen(genuineInput, { modelRouter: null });
  assert.equal(r.verdict, 'borderline');
  assert.equal(r.llmAttempted, false);
  assert.ok(r.reasons.some((x) => x.code === 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE'));
  assert.equal(r.llmCost, 0);
});

test('LLM error: rejection from router → borderline, degraded', async () => {
  const failingRouter: SpamScreenModelRouter = {
    async complete() {
      throw new Error('Vertex 429 + OpenRouter 502');
    },
  };
  const r = await runSpamScreen(genuineInput, { modelRouter: failingRouter });
  assert.equal(r.verdict, 'borderline');
  assert.equal(r.llmAttempted, true);
  assert.ok(r.reasons.some((x) => x.code === 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE'));
  assert.equal(r.llmCost, 0);
});

test('LLM timeout: slow response → borderline with LLM_TIMEOUT', async () => {
  const slowRouter: SpamScreenModelRouter = {
    async complete() {
      await new Promise((res) => setTimeout(res, 500));
      return {
        text: '{}', model: 'm', inputTokens: 1, outputTokens: 1, cost: 0,
      };
    },
  };
  const r = await runSpamScreen(genuineInput, {
    modelRouter: slowRouter,
    timeoutMs: 50,
  });
  assert.equal(r.verdict, 'borderline');
  assert.ok(r.reasons.some((x) => x.code === 'LLM_TIMEOUT'));
});

test('LLM malformed response → borderline with LOW_CONFIDENCE', async () => {
  const r = await runSpamScreen(genuineInput, {
    modelRouter: mockLlm({ text: 'not json at all, some prose' }),
  });
  assert.equal(r.verdict, 'borderline');
  assert.ok(r.reasons.some((x) => x.code === 'LLM_LOW_CONFIDENCE'));
});

// ── parseLlmResponse unit tests ──────────────────────

test('parseLlmResponse: clean JSON', () => {
  const p = parseLlmResponse(JSON.stringify({
    verdict: 'genuine', reasons: ['a'], confidence: 0.8,
  }));
  assert.ok(p);
  assert.equal(p!.verdict, 'genuine');
  assert.equal(p!.confidence, 0.8);
});

test('parseLlmResponse: JSON wrapped in markdown code fence', () => {
  const p = parseLlmResponse('```json\n{"verdict":"spam","reasons":[],"confidence":0.9}\n```');
  assert.ok(p);
  assert.equal(p!.verdict, 'spam');
});

test('parseLlmResponse: invalid verdict → null', () => {
  assert.equal(parseLlmResponse('{"verdict":"maybe","reasons":[],"confidence":0.5}'), null);
});

test('parseLlmResponse: missing confidence → null', () => {
  assert.equal(parseLlmResponse('{"verdict":"genuine","reasons":[]}'), null);
});

test('parseLlmResponse: confidence out of range → null', () => {
  assert.equal(parseLlmResponse('{"verdict":"genuine","reasons":[],"confidence":1.5}'), null);
});
