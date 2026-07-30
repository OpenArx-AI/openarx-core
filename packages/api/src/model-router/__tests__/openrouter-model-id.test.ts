/**
 * Model-id normalisation for the Vertex → OpenRouter provider switch.
 *
 * Vertex and OpenRouter name the SAME Google model differently (`gemini-3-flash-preview` vs
 * `google/gemini-3-flash-preview`), and call sites across the pipeline hardcode the Vertex spelling
 * because Vertex was the provider. Without normalisation every one of those calls would fail with
 * an unknown-model error the moment the credentials are removed — and it would fail at switch-over,
 * not at deploy, which is the worst time to discover it.
 *
 * The ids asserted here were checked against the live OpenRouter catalogue on 2026-07-26.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { toOpenRouterModelId } from '../openrouter-llm.js';

test('the Vertex-spelled ids hardcoded in the pipeline map to their OpenRouter equivalents', () => {
  // chunker-step fallback, spam-screen default, language detection default.
  assert.equal(toOpenRouterModelId('gemini-3.1-pro-preview'), 'google/gemini-3.1-pro-preview');
  assert.equal(toOpenRouterModelId('gemini-3-flash-preview'), 'google/gemini-3-flash-preview');
  assert.equal(toOpenRouterModelId('gemini-2.5-flash-lite'), 'google/gemini-2.5-flash-lite');
});

test('an already-namespaced id is passed through untouched (no double prefixing)', () => {
  assert.equal(toOpenRouterModelId('google/gemini-3-flash-preview'), 'google/gemini-3-flash-preview');
  assert.equal(
    toOpenRouterModelId(toOpenRouterModelId('gemini-3-flash-preview')),
    'google/gemini-3-flash-preview',
    'normalisation must be idempotent — it may run twice on a retry path',
  );
});

test('other vendors are never rewritten to google/', () => {
  assert.equal(toOpenRouterModelId('qwen/qwen3-embedding-8b'), 'qwen/qwen3-embedding-8b');
  assert.equal(toOpenRouterModelId('anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
  assert.equal(toOpenRouterModelId('openai/gpt-4o'), 'openai/gpt-4o');
});

test('a non-gemini bare id is left alone rather than guessed at', () => {
  // Prefixing an unknown vendor's model with google/ would turn a clear "unknown model" error into
  // a wrong-vendor request. Only the gemini family is rewritten, because only it is known to be
  // spelled differently by the two providers we use.
  assert.equal(toOpenRouterModelId('llama-3-70b'), 'llama-3-70b');
  assert.equal(toOpenRouterModelId('some-future-model'), 'some-future-model');
});

test('the gemini prefix match is anchored — a model merely containing "gemini" is not rewritten', () => {
  assert.equal(toOpenRouterModelId('not-gemini-clone'), 'not-gemini-clone');
  assert.equal(toOpenRouterModelId('vendor/gemini-3-flash'), 'vendor/gemini-3-flash');
});

test('every model the pipeline names has an explicit price — an unpriced model must not be costed as flash', async () => {
  // Regression for a real accounting defect: the price table held only flash, so a chunker retry on
  // the pro model was billed at flash rates and under-reported 4x. Cost figures that are silently
  // wrong are worse than missing ones, because they still look like measurements.
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../openrouter-llm.ts', import.meta.url), 'utf8'),
  );
  for (const model of [
    'google/gemini-3-flash-preview',
    'google/gemini-3.1-pro-preview',
    'google/gemini-2.5-flash-lite',
  ]) {
    assert.ok(src.includes(`'${model}'`), `${model} must carry an explicit price`);
  }
  // And the fallback must be the DEAREST rate, so an unknown model over-states rather than hides cost.
  assert.ok(
    /UNKNOWN_MODEL_RATE = \{ input: 2, output: 12 \}/.test(src),
    'the unknown-model fallback must be the dearest known rate',
  );
});

test('a 429 error carries the status and Retry-After so the backoff can recognise it', async () => {
  // The rate-limit path must not depend on parsing an error message. Regression for the run where
  // 63 × 429 were retried at 1s/2s — shorter than the limit window — and 14 documents failed.
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../openrouter-llm.ts', import.meta.url), 'utf8'),
  );
  assert.ok(/error\.status = resp\.status/.test(src), '429 must be recognisable by status, not text');
  assert.ok(/retry-after/i.test(src), "the provider's Retry-After must be honoured");
  // Waits must exceed the minute-scale window the limit is measured over, and be jittered so a
  // concurrent pool de-synchronises instead of re-colliding on every attempt.
  assert.ok(/RATE_LIMIT_WAITS_MS = \[15_000, 45_000, 120_000\]/.test(src), 'waits must be long');
  assert.ok(/0\.75 \+ Math\.random\(\) \* 0\.5/.test(src), 'waits must be jittered');
});
