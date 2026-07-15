import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLlmLangId } from '../llm-lang-id.js';

// The completion is mocked, so it returns a fixed verdict regardless of the input text —
// input strings here just need to be long enough (>=3 chars) to trigger a call.

test('llm-lang-id — parses model JSON and lowercases the language code', async () => {
  const detect = makeLlmLangId(async () => '{"lang":"RU","confidence":0.95}', 'm');
  assert.deepEqual(await detect('some sample text long enough'), { lang: 'ru', confidence: 0.95 });
});

test('llm-lang-id — English passes through unchanged', async () => {
  const detect = makeLlmLangId(async () => '{"lang":"en","confidence":0.99}', 'm');
  assert.deepEqual(await detect('hello world this is english'), { lang: 'en', confidence: 0.99 });
});

test('llm-lang-id — too-short text returns undetermined WITHOUT calling the model', async () => {
  let called = false;
  const detect = makeLlmLangId(async () => {
    called = true;
    return '{"lang":"en","confidence":1}';
  }, 'm');
  assert.deepEqual(await detect('a'), { lang: 'und', confidence: 0 });
  assert.equal(called, false);
});

test('llm-lang-id — unparseable model output → undetermined (fail-open)', async () => {
  const detect = makeLlmLangId(async () => 'not json at all', 'm');
  assert.deepEqual(await detect('some text here to detect'), { lang: 'und', confidence: 0 });
});

test('llm-lang-id — model error → undetermined (fail-open, never blocks the pipeline)', async () => {
  const detect = makeLlmLangId(async () => {
    throw new Error('detector down');
  }, 'm');
  assert.deepEqual(await detect('some text here to detect'), { lang: 'und', confidence: 0 });
});

test('llm-lang-id — out-of-range confidence is coerced to 0', async () => {
  const detect = makeLlmLangId(async () => '{"lang":"fr","confidence":5}', 'm');
  assert.deepEqual(await detect('bonjour le monde entier'), { lang: 'fr', confidence: 0 });
});
