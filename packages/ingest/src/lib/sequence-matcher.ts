/**
 * sequence-matcher.ts — word-level longest-matching-block alignment.
 *
 * A faithful TypeScript port of Python `difflib.SequenceMatcher`
 * (autojunk=False, isjunk=None): `get_matching_blocks` + `ratio`. Extracted from
 * the experimenter verbatim-recovery reference (vr_lib.ts / vr_lib.py, beads
 * experimenter_agent-vcw), validated bit-for-bit against the Python reference on
 * the saved corpus. Self-contained, no external dependencies.
 *
 * Consumed by ./verbatim-recovery via `../lib/sequence-matcher.js`. Do NOT change
 * the algorithm without re-running the recovery parity harness — the recovery
 * guarantees (99.7% exact, 0 silent-wrong) depend on identical alignment output.
 */

/** A matching block `[a-index, b-index, size]` (same shape as difflib's Match). */
export type Block = [number, number, number];

/** Map each element of `b` to the sorted list of its indices (difflib b2j). */
function buildB2J(b: string[]): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const arr = b2j.get(b[i]);
    if (arr) arr.push(i);
    else b2j.set(b[i], [i]);
  }
  return b2j;
}

/** difflib.SequenceMatcher.find_longest_match over a[alo:ahi] × b[blo:bhi]. */
function findLongestMatch(
  a: string[],
  b: string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Block {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const js = b2j.get(a[i]);
    if (js) {
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--;
    bestj--;
    bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

/** difflib.SequenceMatcher.get_matching_blocks — the non-adjacent matching blocks
 *  plus the terminating `[la, lb, 0]` sentinel. */
export function getMatchingBlocks(a: string[], b: string[]): Block[] {
  const la = a.length;
  const lb = b.length;
  const b2j = buildB2J(b);
  const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
  const blocks: Block[] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent: Block[] = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);
  return nonAdjacent;
}

/** difflib.SequenceMatcher.ratio — 2*matches / (len(a)+len(b)). */
export function ratio(a: string[], b: string[]): number {
  let matches = 0;
  for (const blk of getMatchingBlocks(a, b)) matches += blk[2];
  const total = a.length + b.length;
  return total ? (2 * matches) / total : 1.0;
}
