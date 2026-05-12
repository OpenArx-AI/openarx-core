/**
 * Post-processing fix for mid-sentence chunk boundaries.
 *
 * When LLM chunker cuts a chunk mid-sentence, trim backward to the
 * last complete sentence. For same-section adjacent chunks, can also
 * extend forward into the next chunk.
 *
 * Runs after LLM chunking, before cross-batch dedup.
 */

import type { Chunk } from '@openarx/types';

const MAX_BACKWARD = 300;
const MIN_CHUNK_AFTER_TRIM = 80;

const SENTENCE_END = /[.!?:;)]\s*$/;

// Abbreviations that end with period but aren't sentence ends
const ABBREV = /(?:et\sal|Fig|Eq|Ref|Sec|Tab|Vol|vs|i\.e|e\.g|al|approx|resp)$/i;

/**
 * Check if chunk text ends at a sentence boundary.
 * Strips trailing LaTeX environment closers before checking.
 */
function endsAtSentence(text: string): boolean {
  const stripped = text.replace(/(\s*\\end\{[^}]+\}\s*)*$/, '').trimEnd();
  return SENTENCE_END.test(stripped);
}

/**
 * Find the last sentence-ending position in text, searching backward
 * up to maxBackward chars from the end.
 *
 * Returns the cut index (exclusive) or -1 if not found.
 * Skips abbreviations and positions inside math mode.
 */
function findLastSentenceEnd(text: string, maxBackward: number): number {
  const start = Math.max(0, text.length - maxBackward);
  const region = text.slice(start);

  const candidates: number[] = [];
  const re = /[.!?](?:\s|$)/g;
  let m;
  while ((m = re.exec(region)) !== null) {
    const absPos = start + m.index + 1;

    // Skip abbreviations
    const before = text.slice(Math.max(0, absPos - 8), absPos - 1);
    if (ABBREV.test(before)) continue;

    // Skip if inside inline math (odd number of unescaped $)
    const textBefore = text.slice(0, absPos);
    const dollars = (textBefore.match(/(?<!\\)\$/g) || []).length;
    if (dollars % 2 !== 0) continue;

    // Skip if inside display math \[...\]
    const openDisp = (textBefore.match(/\\\[/g) || []).length;
    const closeDisp = (textBefore.match(/\\\]/g) || []).length;
    if (openDisp > closeDisp) continue;

    candidates.push(absPos);
  }

  return candidates.length > 0 ? candidates[candidates.length - 1] : -1;
}

/**
 * Fix mid-sentence chunk boundaries by trimming backward to the last
 * complete sentence.
 *
 * Mutates chunks array in place. Returns the number of chunks fixed.
 */
export function fixChunkBoundaries(chunks: Chunk[]): number {
  let fixed = 0;

  for (const chunk of chunks) {
    if (endsAtSentence(chunk.content)) continue;

    const trimPoint = findLastSentenceEnd(chunk.content, MAX_BACKWARD);
    if (trimPoint <= 0) continue;

    const trimmed = chunk.content.slice(0, trimPoint).trimEnd();
    if (trimmed.length < MIN_CHUNK_AFTER_TRIM) continue;

    chunk.content = trimmed;
    fixed++;
  }

  return fixed;
}
