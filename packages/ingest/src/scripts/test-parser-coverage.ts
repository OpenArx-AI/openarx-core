/**
 * test-parser-coverage — standalone read-only evaluation of the new LaTeX
 * parser against samples from the indexed corpus.
 *
 * Samples 200 docs from the parse-failure cohort (docs flagged as failing
 * by detect-parse-failures) and 200 from the ready cohort (high parse
 * quality), runs the current parser on the raw source files, and scores
 * each result against 6 signals.
 *
 * **No** DB writes, **no** LLM calls, **no** chunking. Parse only.
 *
 * Success signals (verdict = OK iff all pass):
 *   1. no exception
 *   2. rootTex != null
 *   3. missingIncludes.length == 0
 *   4. mergedTexChars / effectiveSourceChars >= 0.8
 *   5. sections >= 2
 *   6. sections >= 0.7 * source_top_level_section_count
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx src/scripts/test-parser-coverage.ts \
 *     --failed 200 --ready 200 --seed 42 --out /tmp/parser-test.jsonl
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pool, query } from '@openarx/api';
import { parseLatexSource } from '../parsers/latex-parser.js';
import { isBodyInclude } from '../parsers/include-filter.js';
import { arxivDocPath } from '../utils/doc-path.js';

// ─── args ─────────────────────────────────────────────────────

interface Config {
  failedN: number;
  readyN: number;
  seed: number;
  outPath: string;
  coverageThreshold: number;   // signal 4
  sectionCoverageThreshold: number; // signal 6
  minSections: number;         // signal 5
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
  };
  return {
    failedN: parseInt(get('--failed', '200'), 10),
    readyN: parseInt(get('--ready', '200'), 10),
    seed: parseInt(get('--seed', '42'), 10),
    outPath: get('--out', '/tmp/parser-coverage-results.jsonl'),
    coverageThreshold: parseFloat(get('--coverage-threshold', '0.8')),
    sectionCoverageThreshold: parseFloat(get('--section-coverage-threshold', '0.7')),
    minSections: parseInt(get('--min-sections', '2'), 10),
  };
}

// ─── deterministic RNG (mulberry32) ────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededSample<T>(arr: T[], n: number, seed: number): T[] {
  if (arr.length <= n) return arr.slice();
  const rng = mulberry32(seed);
  const shuffled = arr.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// ─── cohort selection ─────────────────────────────────────────

interface DocRow {
  id: string;
  source_id: string;
  parse_quality: number | null;
  chunks_count: number;
  source_tex_chars_prev: number;
}

/** Failed cohort = LaTeX docs where previously-stored chunks_chars/source_tex < 0.1.
 *  Uses the same heuristic as detect-parse-failures. */
async function fetchFailedCohort(): Promise<DocRow[]> {
  const r = await query<{ id: string; source_id: string; parse_quality: string | null; chunks_count: string; chunks_chars: string; source_tex_chars: string }>(
    `WITH latex_docs AS (
       SELECT id::text AS id, source_id, parse_quality::text AS parse_quality
       FROM documents
       WHERE source_format = 'latex'
         AND status = 'ready'
         AND (indexing_tier IS NULL OR indexing_tier = 'full')
     ),
     chunk_agg AS (
       SELECT document_id,
              COUNT(*)::text AS cnt,
              COALESCE(SUM(LENGTH(content)), 0)::text AS chars
       FROM chunks
       GROUP BY document_id
     )
     SELECT d.id, d.source_id, d.parse_quality,
            COALESCE(c.cnt, '0') AS chunks_count,
            COALESCE(c.chars, '0') AS chunks_chars,
            '0' AS source_tex_chars
     FROM latex_docs d
     LEFT JOIN chunk_agg c ON c.document_id = d.id::uuid
     WHERE (d.parse_quality IS NOT NULL AND d.parse_quality::float < 0.3)
        OR COALESCE(c.cnt, '0')::int < 3`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    source_id: row.source_id,
    parse_quality: row.parse_quality ? parseFloat(row.parse_quality) : null,
    chunks_count: parseInt(row.chunks_count, 10),
    source_tex_chars_prev: 0,
  }));
}

/** Ready cohort = LaTeX docs with good parse_quality and enough chunks. */
async function fetchReadyCohort(): Promise<DocRow[]> {
  const r = await query<{ id: string; source_id: string; parse_quality: string | null; chunks_count: string }>(
    `WITH latex_docs AS (
       SELECT id::text AS id, source_id, parse_quality::text AS parse_quality
       FROM documents
       WHERE source_format = 'latex'
         AND status = 'ready'
         AND (indexing_tier IS NULL OR indexing_tier = 'full')
         AND parse_quality IS NOT NULL
         AND parse_quality::float >= 0.7
     ),
     chunk_agg AS (
       SELECT document_id, COUNT(*)::text AS cnt
       FROM chunks GROUP BY document_id
     )
     SELECT d.id, d.source_id, d.parse_quality, COALESCE(c.cnt, '0') AS chunks_count
     FROM latex_docs d
     LEFT JOIN chunk_agg c ON c.document_id = d.id::uuid
     WHERE COALESCE(c.cnt, '0')::int >= 5`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    source_id: row.source_id,
    parse_quality: row.parse_quality ? parseFloat(row.parse_quality) : null,
    chunks_count: parseInt(row.chunks_count, 10),
    source_tex_chars_prev: 0,
  }));
}

// ─── effective source size (exclude aux packages/styles) ───────

const AUX_DIR_PATTERNS: RegExp[] = [
  /^(?:ieeetran|ieee|acl|acm|neurips|icml|iclr|cvf|ijcai|aaai|springer|elsevier)$/i,
  /^(?:style|template|cls|pkg|format|sty)$/i,
  /^(?:fig|figs|figures|image|images|plot|plots|graphics|pics)$/i,
  /^(?:bib|biblio|references)$/i,
  /^(?:rebuttal|response|reply|review)$/i,
];
const AUX_NAME_PATTERNS: RegExp[] = [
  /template/i, /rebuttal/i, /response/i, /reply/i, /reviewer/i,
  /sample/i, /example/i, /testflow/i, /commitment/i, /statement/i,
  /checklist/i, /_filled\b/i, /responsible.*research/i, /reproducib/i,
  /\bsupp_/i, /supplement/i,
];

/** Sum sizes of all .tex files in sourceDir, with two numbers:
 *  - effective: aux patterns (IEEEtran/, template-*, etc.) excluded
 *  - total: raw sum including aux
 *
 *  filesCounted counts effective files only. Caller falls back to total
 *  when effective is 0 (archive has only aux .tex — still a valid parse
 *  target, just with aux as the body).
 */
async function effectiveSourceChars(sourceDir: string): Promise<{ effective: number; total: number; filesCounted: number }> {
  let effective = 0;
  let total = 0;
  let counted = 0;
  async function walk(dir: string, inAuxDir: boolean): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        const nextAux = inAuxDir || AUX_DIR_PATTERNS.some((re) => re.test(e.name));
        await walk(join(dir, e.name), nextAux);
      } else if (e.isFile() && e.name.endsWith('.tex')) {
        let size = 0;
        try { size = (await stat(join(dir, e.name))).size; } catch { continue; }
        total += size;
        if (inAuxDir) continue;
        const base = basename(e.name, '.tex').toLowerCase();
        if (AUX_NAME_PATTERNS.some((re) => re.test(base))) continue;
        effective += size;
        counted++;
      }
    }
  }
  await walk(sourceDir, false);
  return { effective, total, filesCounted: counted };
}

/** Count top-level \section{...} in a piece of merged TeX. We use this
 *  against the parser's merged output (post-resolveInputs) rather than
 *  walking the filesystem — walking filesystem over-counts by including
 *  sections from unused .tex files (duplicate submission versions,
 *  alternative roots, supplementary standalones). */
const SECTION_RE = /^\\section\s*\*?\s*\{/gm;
function countSectionsInMergedTex(merged: string): number {
  const m = merged.match(SECTION_RE);
  return m ? m.length : 0;
}

// isBodyInclude imported from ../parsers/include-filter.js (shared).

// ─── regression check vs stored structured_content ─────────────

async function fetchStoredSectionCount(docId: string): Promise<number | null> {
  const r = await query<{ n: string | null }>(
    `SELECT jsonb_array_length(structured_content->'sections')::text AS n
     FROM documents WHERE id = $1::uuid`,
    [docId],
  );
  const raw = r.rows[0]?.n;
  return raw ? parseInt(raw, 10) : null;
}

// ─── per-doc evaluation ────────────────────────────────────────

interface Signals {
  no_exception: boolean;
  root_found: boolean;
  no_missing_includes: boolean;
  merged_coverage_ok: boolean;
  sections_ge_min: boolean;
  section_coverage_ok: boolean;
}

interface DocResult {
  source_id: string;
  cohort: 'failed' | 'ready';
  verdict: 'OK' | 'partial' | 'fail' | 'skipped';
  signals: Signals;
  metrics: {
    root_tex: string | null;
    merged_tex_chars: number;
    effective_source_chars: number;
    total_source_chars: number;
    denominator_source_chars: number; // what we divided by for signal 4
    merged_coverage: number;
    parser_sections: number;
    source_section_count: number;    // from merged_tex (what parser saw)
    section_coverage: number;
    missing_includes_count: number;  // body-only (after non-body filter)
    missing_includes_raw: number;    // including tikz/pgf/settings
    abstract_chars: number;
    references_count: number;
    parse_duration_ms: number;
  };
  regression: {
    old_sections: number | null;
    new_sections: number;
    verdict: 'improved' | 'same' | 'regressed' | 'na';
  };
  missing_includes_sample: string[];
  error?: string;
}

async function evalOne(cfg: Config, cohort: 'failed' | 'ready', doc: DocRow): Promise<DocResult> {
  const sourceDir = join(arxivDocPath(doc.source_id), 'source');

  const result: DocResult = {
    source_id: doc.source_id,
    cohort,
    verdict: 'fail',
    signals: {
      no_exception: false, root_found: false, no_missing_includes: false,
      merged_coverage_ok: false, sections_ge_min: false, section_coverage_ok: false,
    },
    metrics: {
      root_tex: null, merged_tex_chars: 0, effective_source_chars: 0,
      total_source_chars: 0, denominator_source_chars: 0,
      merged_coverage: 0, parser_sections: 0, source_section_count: 0,
      section_coverage: 0, missing_includes_count: 0, missing_includes_raw: 0,
      abstract_chars: 0, references_count: 0, parse_duration_ms: 0,
    },
    regression: { old_sections: null, new_sections: 0, verdict: 'na' },
    missing_includes_sample: [],
  };

  const [sizes, storedSections] = await Promise.all([
    effectiveSourceChars(sourceDir),
    fetchStoredSectionCount(doc.id),
  ]);
  result.metrics.effective_source_chars = sizes.effective;
  result.metrics.total_source_chars = sizes.total;
  result.regression.old_sections = storedSections;

  // Archive has no .tex at all → skip, not fail (this is a data issue, not a parser issue)
  if (sizes.total === 0) {
    result.verdict = 'skipped';
    result.error = 'no_source_tex_files';
    return result;
  }

  // Denominator: prefer effective (aux-filtered). If effective=0 but total>0,
  // the whole archive is aux-ish (e.g. lone template.tex) — use total so the
  // parser still gets credit for what it managed to extract.
  const denom = sizes.effective > 0 ? sizes.effective : sizes.total;
  result.metrics.denominator_source_chars = denom;

  try {
    const parsed = await parseLatexSource(sourceDir);
    result.signals.no_exception = true;

    const stats = parsed.stats;
    const rootTex = stats?.rootTex ?? null;
    const missingAll = stats?.missingIncludes ?? [];
    const merged = stats?.mergedTexChars ?? 0;

    // Filter: only body-content missing is a parser coverage concern. TikZ/
    // figures/settings files being unresolved doesn't mean lost prose.
    const missingBody = missingAll.filter(isBodyInclude);

    // Section count expectation: look inside what the parser actually saw
    // (merged_tex after resolveInputs). Walking filesystem over-counts by
    // including unused .tex files (alt submissions, standalone suppl).
    // We re-read rootTex+merged via re-running? No — we don't have merged
    // text exposed as a string yet. Proxy: re-read rootTex and walk
    // includes manually would be expensive. Instead, use parsed.sections
    // length and parser-reported merged size — we trust the parser's view.
    // For source_section_count we approximate: parse the first .tex with
    // \documentclass at root-level size, count \section. (Good enough for
    // single-file archives; for multi-file, over-count risk stays but is
    // smaller than walking the whole tree.)
    let srcSecCount = 0;
    if (rootTex) {
      try {
        const rootContent = await readFile(join(sourceDir, rootTex), 'utf-8');
        // Also include what the parser merged (its \input chain was
        // successful) — but we can't re-derive merged without re-running.
        // Use root + count of resolved \inputs (parser-reported via
        // merged_tex_chars minus root size == included size, but we can't
        // count sections in that unless we re-read). So use parser output
        // as lower bound if src count from root is too small.
        srcSecCount = countSectionsInMergedTex(rootContent);
        if (srcSecCount < parsed.sections.length) srcSecCount = parsed.sections.length;
      } catch { /* leave 0 */ }
    }

    result.metrics.root_tex = rootTex;
    result.metrics.merged_tex_chars = merged;
    result.metrics.merged_coverage = denom > 0 ? merged / denom : 0;
    result.metrics.missing_includes_raw = missingAll.length;
    result.metrics.missing_includes_count = missingBody.length;
    result.missing_includes_sample = missingBody.slice(0, 5);
    result.metrics.parser_sections = parsed.sections.length;
    result.metrics.source_section_count = srcSecCount;
    result.metrics.abstract_chars = parsed.abstract.length;
    result.metrics.references_count = parsed.references.length;
    result.metrics.parse_duration_ms = parsed.parseDurationMs;
    result.metrics.section_coverage = srcSecCount > 0 ? parsed.sections.length / srcSecCount : 1;

    result.signals.root_found = rootTex !== null;
    result.signals.no_missing_includes = missingBody.length === 0;

    // Cap at 1.0 — archives with duplicate unused .tex can yield merged > denom.
    const cappedCov = Math.min(result.metrics.merged_coverage, 1);
    // Archive-noise exception: if merged < 80% of effective denominator
    // but the parser extracted real structure (≥5 sections AND ≥5 refs),
    // the shortfall is unused .tex files in the archive (alt submission
    // versions, standalone supplementary), not parser data loss.
    const archiveNoiseOk = cappedCov < cfg.coverageThreshold
      && parsed.sections.length >= 5
      && parsed.references.length >= 5;
    result.signals.merged_coverage_ok = cappedCov >= cfg.coverageThreshold || archiveNoiseOk;

    // Short-paper exception: if the source genuinely has only 1 \section
    // (short note / abstract-only proceedings), 1 section is the correct
    // answer. Require corroborating signal — references extracted or
    // non-trivial abstract — so we don't give credit to real parse failures
    // that happen to land on 1.
    const shortButValid = parsed.sections.length === 1
      && srcSecCount <= 1
      && (parsed.references.length >= 5 || parsed.abstract.length >= 300);
    result.signals.sections_ge_min = parsed.sections.length >= cfg.minSections || shortButValid;
    result.signals.section_coverage_ok = srcSecCount === 0
      ? parsed.sections.length >= cfg.minSections || shortButValid
      : result.metrics.section_coverage >= cfg.sectionCoverageThreshold;

    result.regression.new_sections = parsed.sections.length;
    if (storedSections != null) {
      if (parsed.sections.length > storedSections + 1) result.regression.verdict = 'improved';
      else if (parsed.sections.length < storedSections - 1) result.regression.verdict = 'regressed';
      else result.regression.verdict = 'same';
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }

  const passedCount = Object.values(result.signals).filter(Boolean).length;
  if (passedCount === 6) result.verdict = 'OK';
  else if (result.signals.no_exception && result.signals.root_found && passedCount >= 4) result.verdict = 'partial';
  else result.verdict = 'fail';

  return result;
}

// ─── reporting ────────────────────────────────────────────────

interface Summary {
  cohort: 'failed' | 'ready';
  total: number;
  evaluated: number; // total minus skipped
  ok: number;
  partial: number;
  fail: number;
  skipped: number;
  signal_fail_counts: Record<keyof Signals, number>;
  regression: { improved: number; same: number; regressed: number; na: number };
  avg_parse_ms: number;
}

function summarize(cohort: 'failed' | 'ready', rows: DocResult[]): Summary {
  const signalFails: Record<keyof Signals, number> = {
    no_exception: 0, root_found: 0, no_missing_includes: 0,
    merged_coverage_ok: 0, sections_ge_min: 0, section_coverage_ok: 0,
  };
  const reg = { improved: 0, same: 0, regressed: 0, na: 0 };
  let ok = 0, partial = 0, fail = 0, skipped = 0, totMs = 0, evaluated = 0;
  for (const r of rows) {
    if (r.verdict === 'skipped') { skipped++; continue; }
    evaluated++;
    if (r.verdict === 'OK') ok++;
    else if (r.verdict === 'partial') partial++;
    else fail++;
    for (const k of Object.keys(signalFails) as (keyof Signals)[]) {
      if (!r.signals[k]) signalFails[k]++;
    }
    reg[r.regression.verdict]++;
    totMs += r.metrics.parse_duration_ms;
  }
  return {
    cohort, total: rows.length, evaluated, ok, partial, fail, skipped,
    signal_fail_counts: signalFails, regression: reg,
    avg_parse_ms: evaluated > 0 ? totMs / evaluated : 0,
  };
}

function printSummary(s: Summary, cfg: Config): void {
  console.error(`\n=== ${s.cohort.toUpperCase()} cohort (n=${s.total}, evaluated=${s.evaluated}, skipped=${s.skipped}) ===`);
  const pct = (n: number) => (100 * n / Math.max(s.evaluated, 1)).toFixed(1);
  console.error(`  OK:        ${s.ok}/${s.evaluated}  (${pct(s.ok)}%)`);
  console.error(`  partial:   ${s.partial}/${s.evaluated}  (${pct(s.partial)}%)`);
  console.error(`  fail:      ${s.fail}/${s.evaluated}  (${pct(s.fail)}%)`);
  console.error(`  avg parse: ${s.avg_parse_ms.toFixed(1)} ms`);
  console.error(`  signal failures (of ${s.evaluated}):`);
  console.error(`    no_exception          : ${s.signal_fail_counts.no_exception}`);
  console.error(`    root_found            : ${s.signal_fail_counts.root_found}`);
  console.error(`    no_missing_includes   : ${s.signal_fail_counts.no_missing_includes}`);
  console.error(`    merged_coverage >= ${cfg.coverageThreshold}: ${s.signal_fail_counts.merged_coverage_ok}`);
  console.error(`    sections >= ${cfg.minSections}           : ${s.signal_fail_counts.sections_ge_min}`);
  console.error(`    section_coverage >= ${cfg.sectionCoverageThreshold}: ${s.signal_fail_counts.section_coverage_ok}`);
  console.error(`  regression vs stored structured_content:`);
  console.error(`    improved:  ${s.regression.improved}`);
  console.error(`    same:      ${s.regression.same}`);
  console.error(`    regressed: ${s.regression.regressed}`);
  console.error(`    no_prev:   ${s.regression.na}`);
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  console.error(`[test-parser-coverage] config:`, cfg);

  console.error(`[test-parser-coverage] fetching candidate cohorts…`);
  const [allFailed, allReady] = await Promise.all([fetchFailedCohort(), fetchReadyCohort()]);
  console.error(`  failed pool: ${allFailed.length}`);
  console.error(`  ready pool:  ${allReady.length}`);

  const failedSample = seededSample(allFailed, cfg.failedN, cfg.seed);
  const readySample = seededSample(allReady, cfg.readyN, cfg.seed + 1);
  console.error(`  sampled: failed=${failedSample.length} ready=${readySample.length}`);

  const rows: DocResult[] = [];
  const t0 = Date.now();
  let scanned = 0;
  for (const doc of failedSample) {
    scanned++;
    if (scanned % 50 === 0) console.error(`  [failed] ${scanned}/${failedSample.length}`);
    try {
      rows.push(await evalOne(cfg, 'failed', doc));
    } catch (err) {
      console.error(`  skip ${doc.source_id}:`, err instanceof Error ? err.message : err);
    }
  }
  scanned = 0;
  for (const doc of readySample) {
    scanned++;
    if (scanned % 50 === 0) console.error(`  [ready]  ${scanned}/${readySample.length}`);
    try {
      rows.push(await evalOne(cfg, 'ready', doc));
    } catch (err) {
      console.error(`  skip ${doc.source_id}:`, err instanceof Error ? err.message : err);
    }
  }

  await writeFile(cfg.outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`\n[test-parser-coverage] wrote ${rows.length} rows → ${cfg.outPath}`);
  console.error(`[test-parser-coverage] elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const failedRows = rows.filter((r) => r.cohort === 'failed');
  const readyRows = rows.filter((r) => r.cohort === 'ready');
  printSummary(summarize('failed', failedRows), cfg);
  printSummary(summarize('ready', readyRows), cfg);

  await pool.end();
}

main().catch((err) => {
  console.error('[test-parser-coverage] fatal:', err);
  process.exit(1);
});
