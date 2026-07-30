/**
 * embed-input-cap — the `--max-embed-tokens` input cap, extracted from reprocess-qwen so it is
 * unit-testable (importing the script itself would execute its main()).
 *
 * ★ WHY THE SURROGATE GUARD EXISTS (bug openarx-i4r8, root cause confirmed 2026-07-26)
 * The cap slices a JS string, and JS strings are UTF-16: a non-BMP character — e.g. U+1D458
 * MATHEMATICAL ITALIC SMALL K, which is common in maths papers — occupies TWO code units. A
 * naive `slice(0, maxChars)` can therefore cut BETWEEN the two halves of a surrogate pair,
 * leaving a LONE HIGH SURROGATE at the end. JSON.stringify serialises that as a bare `\udXXX`
 * escape, which a strict JSON parser rejects outright: TEI (Rust serde_json) answered
 * `400 Failed to parse the request body as JSON: input[N]: unexpected end of hex escape`, and
 * since every retry hit the same payload the whole document failed deterministically.
 * Measured on the failing set: of 463 chunks, 8 exceeded the cap and 4 of those had the cut
 * land inside a surrogate pair. So the guard below is the fix: never end on a lone surrogate.
 */

/** Approx chars/token for the input cap (~4 on English/scientific text; only bounds the
 *  embed INPUT length, so a loose estimate is fine — TEI re-tokenizes what it receives). */
export const CHARS_PER_TOKEN = 4;

/** Truncate an embed input to at most `maxTokens` tokens (0 = no cap). Long-tail chunks
 *  (up to ~13K tok) cost ~40× a normal ~316-tok chunk and dominate their batch's GPU time;
 *  capping the INPUT (not the stored content, which stays full in PG/Qdrant) collapses the
 *  tail and restores throughput. Returns whether it truncated (for observability).
 *
 *  Surrogate-safe: if the cut would split a surrogate pair, it moves back one code unit so the
 *  result is always well-formed UTF-16 (and therefore serialises to valid JSON). Dropping that
 *  single unit costs half a character out of ~4096 — the alternative is a rejected request. */
export function capEmbedInput(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text, truncated: false };
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const lastUnit = text.charCodeAt(end - 1);
  // 0xD800-0xDBFF = high surrogate. Ending on one means its low half was cut off.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
