/**
 * Content-safe JSON escape repair for the chunker base call (openarx cost fix).
 * Pins the contract empirically validated on 120 real failure samples
 * (chunking-debug.jsonl): 99% repaired, 100% of escape occurrences preserved —
 * vs jsonrepair, which DROPS the backslash (\hat → hat) and corrupts LaTeX.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairJsonEscapes, parseChunkJson } from './chunker-step.js';

/** Build a chunker-shaped JSON source whose first chunk text == `content`
 *  (content may contain single backslashes → an invalid-escape, broken JSON). */
function srcWith(content: string): string {
  return `{"chunks":[{"text":"${content}","section":"S"}],"metadata":{}}`;
}
function firstText(json: string): string {
  return (JSON.parse(json) as { chunks: { text: string }[] }).chunks[0].text;
}

test('repairJsonEscapes: single-backslash LaTeX commands are PRESERVED, not dropped', () => {
  // each `cmd` here begins with an INVALID JSON escape char → breaks JSON.parse
  for (const cmd of ['\\hat', '\\Delta', '\\alpha', '\\mathcal', '\\{', '\\}', '\\%', '\\,', "\\'"]) {
    const broken = srcWith(`a ${cmd} b`);
    assert.throws(() => JSON.parse(broken)); // precondition: the single-backslash command breaks JSON
    assert.equal(firstText(repairJsonEscapes(broken)), `a ${cmd} b`, `${cmd} must survive verbatim`);
  }
});

test('repairJsonEscapes: already-valid \\\\command is untouched (escape-pair-aware)', () => {
  // "\\in" is a correctly-escaped backslash; must stay \in, NOT become \\\in
  const valid = srcWith('x \\\\in S \\\\sqrt{n}');
  assert.doesNotThrow(() => JSON.parse(valid));
  assert.equal(firstText(repairJsonEscapes(valid)), 'x \\in S \\sqrt{n}');
});

test('repairJsonEscapes: standard JSON escapes preserved', () => {
  const src = '{"chunks":[{"text":"l1\\nl2\\ttab \\"q\\" \\u00e9","section":"S"}],"metadata":{}}';
  assert.equal(firstText(repairJsonEscapes(src)), 'l1\nl2\ttab "q" é');
});

test('repairJsonEscapes: mixed valid + invalid escapes in one string', () => {
  const broken = srcWith('\\\\sqrt{n} and \\hat\\{x\\}');
  assert.throws(() => JSON.parse(broken));
  assert.equal(firstText(repairJsonEscapes(broken)), '\\sqrt{n} and \\hat\\{x\\}');
});

test('parseChunkJson: valid → repaired:false; broken-escape → repaired:true + content preserved', () => {
  const v = parseChunkJson(srcWith('plain text'));
  assert.equal(v.repaired, false);

  const r = parseChunkJson(srcWith('a \\Delta b'));
  assert.equal(r.repaired, true);
  assert.equal((r.parsed as { chunks: { text: string }[] }).chunks[0].text, 'a \\Delta b');
});

test('parseChunkJson: non-escape malformation (raw control char) still throws → falls through to retry', () => {
  // a real newline inside the string is NOT an escape issue; repair must not mask it
  const bad = '{"chunks":[{"text":"line\nbreak","section":"S"}]}';
  assert.throws(() => parseChunkJson(bad));
});
