/**
 * Regression tests for the embed-input cap (bug openarx-i4r8).
 *
 * The real failure: the cap cut a maths chunk between the halves of a UTF-16 surrogate pair
 * (U+1D458 MATHEMATICAL ITALIC SMALL K), leaving a lone high surrogate; JSON.stringify emitted
 * a bare \udXXX and TEI's parser rejected the whole batch with "unexpected end of hex escape",
 * failing 6 documents deterministically. The cap must never end on a lone surrogate.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { capEmbedInput, CHARS_PER_TOKEN } from '../embed-input-cap.js';

const MATH_K = '\u{1D458}'; // U+1D458, 2 UTF-16 code units (surrogate pair)

/** True when the string ends on an unpaired high surrogate (what broke the JSON body). */
function endsInLoneHighSurrogate(s: string): boolean {
  if (s.length === 0) return false;
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
}

test('no cap when maxTokens is 0', () => {
  const text = 'x'.repeat(10_000);
  assert.deepEqual(capEmbedInput(text, 0), { text, truncated: false });
});

test('short input passes through untouched', () => {
  const r = capEmbedInput('hello', 1024);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
});

test('long ASCII input is cut to exactly maxTokens * CHARS_PER_TOKEN', () => {
  const cap = 1024;
  const r = capEmbedInput('a'.repeat(9000), cap);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, cap * CHARS_PER_TOKEN);
});

test('★ cut landing inside a surrogate pair does not leave a lone surrogate', () => {
  const cap = 10; // maxChars = 40
  const maxChars = cap * CHARS_PER_TOKEN;
  // Place the pair so that the cut falls BETWEEN its two code units.
  const text = 'a'.repeat(maxChars - 1) + MATH_K + 'tail';
  const r = capEmbedInput(text, cap);
  assert.equal(r.truncated, true);
  assert.equal(endsInLoneHighSurrogate(r.text), false, 'must not end on a lone high surrogate');
  // One unit is given up to keep the string well-formed.
  assert.equal(r.text.length, maxChars - 1);
  // And it must round-trip through JSON, which a lone surrogate would break in a strict parser.
  assert.equal(JSON.parse(JSON.stringify(r.text)), r.text);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.text), false);
});

test('a surrogate pair that ends exactly at the boundary is kept whole', () => {
  const cap = 10;
  const maxChars = cap * CHARS_PER_TOKEN;
  const text = 'a'.repeat(maxChars - 2) + MATH_K + 'tail';
  const r = capEmbedInput(text, cap);
  assert.equal(r.text.length, maxChars, 'the complete pair fits, nothing is given up');
  assert.equal(r.text.endsWith(MATH_K), true);
  assert.equal(endsInLoneHighSurrogate(r.text), false);
});

test('maths-heavy text: no cut position ever yields a lone surrogate', () => {
  // Dense non-BMP text: every cut position lands inside or next to a pair.
  const text = (MATH_K + 'x').repeat(4000);
  for (let cap = 1; cap <= 40; cap++) {
    const r = capEmbedInput(text, cap);
    assert.equal(
      endsInLoneHighSurrogate(r.text),
      false,
      `cap=${cap} produced a lone high surrogate`,
    );
    assert.equal(JSON.parse(JSON.stringify(r.text)), r.text);
  }
});
