/**
 * verbatim-recovery.ts — exact chunk-text recovery from the source document.
 *
 * Faithful TypeScript port of the experimenter reference (vr_lib.ts / vr_lib.py,
 * beads experimenter_agent-vcw), validated bit-for-bit against the Python
 * reference on the saved corpus (3587 Stage-1 chunks + 6098 Stage-2 chunks,
 * per-chunk identical status/span). Self-contained, no external dependencies.
 *
 *   Stage 1 (background reprocessing): recoverSequence(chunks, source) — input = full, possibly-distorted text.
 *   Stage 2 (ingest pipeline):        recoverFromAnchorPairs(pairs, source) — input = start/end markers.
 *   Shared:                           coverageCheck(spans, source) — gap/overlap (0 content-loss) control.
 *
 * The word-alignment core (difflib SequenceMatcher port) lives in ../lib/sequence-matcher.
 * Do NOT change the algorithm or the explicit thresholds (minMatch 0.85, head/tail
 * ratio 0.75, MAX_CHUNK_WORDS 700, edge-absorb SMALL 40, …) without re-running the
 * recovery parity/validation harness — the guarantees depend on them.
 */

import { getMatchingBlocks, ratio } from '../lib/sequence-matcher.js';

// ── word/char helpers ──

/** Split into non-whitespace tokens with their [start, end) char offsets in `text`. */
function tokenize(text: string): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m[0], m.index, m.index + m[0].length]);
  return out;
}

/** Canonical form for word matching: drop LaTeX punctuation ($ \ { } ~), lowercase.
 *  Falls back to the plain lowercase word if canonicalization empties it. */
function canon(word: string): string {
  const c = word.replace(/[$\\{}~]/g, '').toLowerCase();
  return c !== '' ? c : word.toLowerCase();
}

/** Python str.split() with no args: trim + split on runs of whitespace; [] for empty. */
function pysplit(s: string): string[] {
  const t = (s || '').trim();
  return t === '' ? [] : t.split(/\s+/);
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

function nonSpaceCount(s: string): number {
  let n = 0;
  for (const ch of s) if (!isSpace(ch)) n++;
  return n;
}

/** True if a coverage gap is a legitimate drop (blank / \iffalse / [figure|table] /
 *  structural markup with no real word ≥ 3 letters), i.e. NOT real content loss. */
export function isDroppableGap(seg: string): boolean {
  const s = seg.trim();
  if (!s) return true;
  if (s.startsWith('\\iffalse')) return true;
  if (/^\[(figure|table)[\s:\]]/i.test(s)) return true;
  let x = s;
  for (let i = 0; i < 6; i++) {
    const x2 = x.replace(/\{[^{}]*\}/g, ' ');
    if (x2 === x) break;
    x = x2;
  }
  x = x.replace(/\\[a-zA-Z@]+\*?/g, ' ');
  x = x.replace(/\[[^\]]*\]/g, ' ');
  x = x.replace(/[^A-Za-z ]/g, ' ');
  return !pysplit(x).some((w) => w.length >= 3);
}

export interface RecResult {
  status: 'recovered' | 'abbreviated' | 'FAILED';
  span: [number, number] | null;
  text: string | null;
  method: string;
  matchedFrac?: number;
  sizeRatio?: number;
  headRatio?: number;
  tailRatio?: number;
}

// ── Stage 1: recoverSequence (input = full, possibly-distorted chunk text) ──

/**
 * Recover the exact source text for each chunk of ONE document/section, processed
 * strictly in order (monotonic cursor = the 0-silent-wrong guarantee). Each result:
 * `recovered` (overwrite with `text`), `abbreviated` (model shortened a table →
 * `text` is the full verbatim table), or `FAILED` (do NOT overwrite; explicit signal).
 */
export function recoverSequence(
  chunks: Array<string | { text: string }>,
  source: string,
  minMatch = 0.85,
): RecResult[] {
  const texts = chunks.map((c) => (typeof c === 'string' ? c : c.text));
  const sw = tokenize(source);
  const canonSrc = sw.map(([w]) => canon(w));
  const out: RecResult[] = [];
  let widx = 0;
  for (const t of texts) {
    const cw = pysplit(t || '').map(canon);
    if (cw.length === 0 || widx >= sw.length) {
      out.push({ status: 'FAILED', span: null, text: null, method: 'empty-or-exhausted' });
      continue;
    }
    const suffix = canonSrc.slice(widx);
    const blocks = getMatchingBlocks(suffix, cw).filter((b) => b[2] > 0);
    if (blocks.length === 0) {
      out.push({ status: 'FAILED', span: null, text: null, method: 'no-anchor' });
      continue;
    }
    const fb = blocks[0];
    const lb = blocks[blocks.length - 1];
    const startSuffix = fb[0] - fb[1];
    const endSuffix = (lb[0] + lb[2] - 1) + ((cw.length - 1) - (lb[1] + lb[2] - 1));
    const gi = widx + Math.max(0, startSuffix);
    let gj = widx + Math.min(suffix.length - 1, endSuffix);
    if (gj < gi) {
      out.push({ status: 'FAILED', span: null, text: null, method: 'bad-span' });
      continue;
    }
    let ext = 0;
    while (gj + 1 < sw.length && sw[gj + 1][0].replace(/[$\\{}~]/g, '') === '' && ext < 3) {
      gj++;
      ext++;
    }
    const span: [number, number] = [sw[gi][1], sw[gj][2]];
    const text = source.slice(span[0], span[1]);
    const cwn = cw.length;
    let matched = 0;
    for (const b of blocks) matched += b[2];
    const matchedFrac = matched / cwn;
    const stext = pysplit(text).map(canon);
    const sizeRatio = stext.length / cwn;
    const K = 8;
    const hr = ratio(stext.slice(0, K), cw.slice(0, K));
    const tr = ratio(stext.slice(-K), cw.slice(-K));
    const tailClose = ratio(stext.slice(-3), cw.slice(-3));
    const base = { span, text, matchedFrac, sizeRatio, headRatio: hr, tailRatio: tr };
    if (hr >= 0.75 && tr >= 0.75 && matchedFrac >= minMatch && sizeRatio <= 1.5) {
      out.push({ status: 'recovered', method: 'align', ...base });
      widx = gj + 1;
    } else if (hr >= 0.75 && tailClose >= 0.6 && matchedFrac >= minMatch - 0.1 && sizeRatio > 1.5) {
      out.push({ status: 'abbreviated', method: 'anchored-abbrev', ...base });
      widx = gj + 1;
    } else {
      out.push({
        status: 'FAILED',
        span,
        text: null,
        method: 'boundary-or-match-fail',
        matchedFrac,
        sizeRatio,
        headRatio: hr,
        tailRatio: tr,
      });
    }
  }
  return out;
}

// ── Stage 2: recoverFromAnchorPairs (input = start/end markers) ──

/** Locate a marker's anchor words in the canonical source from `fromIdx`. */
function locate(
  canonSrc: string[],
  anchorCanon: string[],
  fromIdx: number,
  want: 'start' | 'end',
): number | null {
  if (anchorCanon.length === 0) return null;
  const suffix = canonSrc.slice(fromIdx);
  const blocks = getMatchingBlocks(suffix, anchorCanon).filter((b) => b[2] > 0);
  if (blocks.length === 0) return null;
  if (want === 'start') {
    const fb = blocks[0];
    return fromIdx + Math.max(0, fb[0] - fb[1]);
  }
  const lb = blocks[blocks.length - 1];
  return fromIdx + Math.min(suffix.length - 1, (lb[0] + lb[2] - 1) + ((anchorCanon.length - 1) - (lb[1] + lb[2] - 1)));
}

/**
 * Recover exact chunk text from (start_anchor, end_anchor) marker pairs for ONE
 * document/section in order. Monotonic start search + bounded end window + adjacent
 * reconciliation into a clean tiling. Each result: `recovered` or `FAILED`.
 */
export function recoverFromAnchorPairs(
  pairs: Array<[string, string]>,
  source: string,
  reconcile = true,
): RecResult[] {
  const sw = tokenize(source);
  const canonSrc = sw.map(([w]) => canon(w));
  const N = sw.length;
  const MAX_CHUNK_WORDS = 700;
  interface Raw {
    ok: boolean;
    method?: string;
    ws?: number;
    we?: number;
  }
  const raw: Raw[] = [];
  let startCur = 0;
  for (const [sa, ea] of pairs) {
    const saC = pysplit(sa || '').map(canon);
    const eaC = pysplit(ea || '').map(canon);
    const gi = locate(canonSrc, saC, startCur, 'start');
    if (gi === null) {
      raw.push({ ok: false, method: 'no-start-anchor' });
      continue;
    }
    startCur = gi + 1;
    const bound = canonSrc.slice(0, Math.min(N, gi + MAX_CHUNK_WORDS));
    let gj = locate(bound, eaC, gi, 'end');
    if (gj === null || gj < gi) {
      raw.push({ ok: false, method: 'no-end-anchor' });
      continue;
    }
    let ext = 0;
    while (gj + 1 < N && sw[gj + 1][0].replace(/[$\\{}~]/g, '') === '' && ext < 3) {
      gj++;
      ext++;
    }
    raw.push({ ok: true, ws: gi, we: gj });
  }

  if (reconcile) {
    const loc = raw.filter((r) => r.ok);
    for (let i = 0; i + 1 < loc.length; i++) {
      const a = loc[i];
      const b = loc[i + 1];
      if (b.ws! <= a.we!) {
        a.we = b.ws! - 1;
      } else if (b.ws! > a.we! + 1) {
        if (!isDroppableGap(source.slice(sw[a.we!][2], sw[b.ws!][1]))) a.we = b.ws! - 1;
      }
    }
    if (loc.length) {
      const SMALL = 40;
      const f = loc[0];
      if (f.ws! > 0 && f.ws! <= SMALL && !isDroppableGap(source.slice(0, sw[f.ws!][1]))) f.ws = 0;
      const t = loc[loc.length - 1];
      if (t.we! < N - 1 && N - 1 - t.we! <= SMALL && !isDroppableGap(source.slice(sw[t.we!][2]))) t.we = N - 1;
    }
  }

  const out: RecResult[] = [];
  for (const r of raw) {
    if (!r.ok) {
      out.push({ status: 'FAILED', span: null, text: null, method: r.method! });
      continue;
    }
    const we = Math.max(r.ws!, r.we!);
    const span: [number, number] = [sw[r.ws!][1], sw[we][2]];
    out.push({ status: 'recovered', span, text: source.slice(span[0], span[1]), method: 'anchors' });
  }
  return out;
}

// ── Shared: coverageCheck (0 content-loss verification) ──

export interface Gap {
  start: number;
  end: number;
  text: string;
  nchars: number;
}

export interface Coverage {
  coveragePct: number;
  gaps: Gap[];
  nGaps: number;
  allowedDrops: Gap[];
  nAllowedDrops: number;
  overlaps: Array<[number, number]>;
  nOverlaps: number;
  ordered: boolean;
  nFailedChunks: number;
  cleanTiling: boolean;
}

/**
 * Verify the recovered spans tile the source with no gaps/overlaps (0 content-loss).
 * `cleanTiling` true ⇔ no real gaps, no overlaps, ordered, no FAILED chunks.
 */
export function coverageCheck(
  spans: Array<[number, number] | null>,
  source: string,
  drops: Array<[number, number]> = [],
  allow: (g: string) => boolean = isDroppableGap,
): Coverage {
  const real = spans.filter((s): s is [number, number] => s !== null);
  const nFailed = spans.filter((s) => s === null).length;
  const cmp = (x: [number, number], y: [number, number]): number => x[0] - y[0] || x[1] - y[1];
  const realSorted = [...real].sort(cmp);
  const ordered = real.length === realSorted.length && real.every((s, i) => s[0] === realSorted[i][0] && s[1] === realSorted[i][1]);
  const overlaps: Array<[number, number]> = [];
  for (let i = 0; i + 1 < realSorted.length; i++) {
    const [, e1] = realSorted[i];
    const [s2] = realSorted[i + 1];
    if (s2 < e1) overlaps.push([s2, e1]);
  }
  const intervals = [...real, ...drops].sort(cmp);
  const L = source.length;
  const merged: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    if (!merged.length || s > merged[merged.length - 1][1]) merged.push([s, e]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
  }
  const nonspace = nonSpaceCount(source);
  const nsp = (a: number, b: number): number => nonSpaceCount(source.slice(a, b));
  const gaps: Gap[] = [];
  const allowed: Gap[] = [];
  let cursor = 0;
  const noteGap = (a: number, b: number): void => {
    const seg = source.slice(a, b);
    if (!seg.trim()) return;
    const rec: Gap = { start: a, end: b, text: seg.trim().slice(0, 160), nchars: nsp(a, b) };
    (allow && allow(seg) ? allowed : gaps).push(rec);
  };
  for (const [s, e] of merged) {
    if (s > cursor) noteGap(cursor, s);
    cursor = Math.max(cursor, e);
  }
  if (cursor < L) noteGap(cursor, L);
  const gapNonspace = gaps.reduce((a, g) => a + g.nchars, 0);
  const content = nonspace - allowed.reduce((a, g) => a + g.nchars, 0);
  return {
    coveragePct: content ? Math.round((100 * (content - gapNonspace)) / content * 100) / 100 : 100.0,
    gaps,
    nGaps: gaps.length,
    allowedDrops: allowed,
    nAllowedDrops: allowed.length,
    overlaps,
    nOverlaps: overlaps.length,
    ordered,
    nFailedChunks: nFailed,
    cleanTiling: gaps.length === 0 && overlaps.length === 0 && ordered && nFailed === 0,
  };
}
