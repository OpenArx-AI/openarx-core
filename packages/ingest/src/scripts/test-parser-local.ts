/**
 * test-parser-local — evaluate current LaTeX parser against a local corpus.
 *
 * Reads pre-built TSV files (flagged-docs.tsv and healthy-docs.tsv from
 * experiments/parser-test-corpus/) and runs parser against each doc's
 * source dir extracted locally. No DB calls, no network, fully offline.
 *
 * Use this for fast iterative parser improvement: run before/after each
 * fix, compare metrics. Flagged should drop, healthy must not regress.
 *
 * Inputs (default paths under experiments/parser-test-corpus):
 *   sources/        — extracted tar with yy/mm/arxivId/source/ tree
 *   flagged-docs.tsv — production-flagged baseline metadata
 *   healthy-docs.tsv — regression baseline metadata
 *
 * Output:
 *   /tmp/parser-local-results.jsonl — one record per doc
 *   stderr — aggregate summary
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx src/scripts/test-parser-local.ts \
 *     [--corpus-root <dir>] [--out <path>] [--concurrency 8] [--limit N]
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseLatexSource } from '../parsers/latex-parser.js';
import { isBodyInclude } from '../parsers/include-filter.js';

const DEFAULT_CORPUS_ROOT = '/home/wlad/Projects/openarx/experiments/parser-test-corpus';

interface Config {
  corpusRoot: string;
  flaggedTsv: string;
  healthyTsv: string;
  sourcesRoot: string;
  outPath: string;
  concurrency: number;
  limit: number;        // 0 = no limit
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
  };
  const root = get('--corpus-root', DEFAULT_CORPUS_ROOT);
  return {
    corpusRoot: root,
    flaggedTsv: get('--flagged-tsv', join(root, 'flagged-docs.tsv')),
    healthyTsv: get('--healthy-tsv', join(root, 'healthy-docs.tsv')),
    sourcesRoot: get('--sources', join(root, 'sources')),
    outPath: get('--out', '/tmp/parser-local-results.jsonl'),
    concurrency: parseInt(get('--concurrency', '8'), 10),
    limit: parseInt(get('--limit', '0'), 10),
  };
}

interface CorpusDoc {
  arxivId: string;
  cohort: 'flagged' | 'healthy';
  // Production baseline (from TSV)
  prodSeverity?: string | null;
  prodReason?: string | null;
  prodContentRetention?: number | null;
  prodStructureQuality?: number | null;
  prodParseQuality?: number | null;
  prodRootTex?: string | null;
}

async function loadFlagged(path: string): Promise<CorpusDoc[]> {
  const txt = await readFile(path, 'utf-8');
  const lines = txt.trim().split('\n');
  const header = lines[0].split('\t');
  const idx = (n: string): number => header.indexOf(n);
  const out: CorpusDoc[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    out.push({
      arxivId: cols[idx('source_id')],
      cohort: 'flagged',
      prodSeverity: cols[idx('severity')] || null,
      prodReason: cols[idx('reason')] || null,
      prodContentRetention: parseFloat(cols[idx('content_retention')] || 'NaN') || null,
      prodStructureQuality: parseFloat(cols[idx('structure_quality')] || 'NaN') || null,
      prodParseQuality: parseFloat(cols[idx('parse_quality')] || 'NaN') || null,
      prodRootTex: cols[idx('root_tex')] || null,
    });
  }
  return out;
}

async function loadHealthy(path: string): Promise<CorpusDoc[]> {
  const txt = await readFile(path, 'utf-8');
  const lines = txt.trim().split('\n');
  const header = lines[0].split('\t');
  const idx = (n: string): number => header.indexOf(n);
  const out: CorpusDoc[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    out.push({
      arxivId: cols[idx('source_id')],
      cohort: 'healthy',
      prodParseQuality: parseFloat(cols[idx('parse_quality')] || 'NaN') || null,
      prodContentRetention: parseFloat(cols[idx('content_retention')] || 'NaN') || null,
      prodStructureQuality: parseFloat(cols[idx('structure_quality')] || 'NaN') || null,
      prodRootTex: cols[idx('root_tex')] || null,
    });
  }
  return out;
}

function arxivLocalPath(sourcesRoot: string, arxivId: string): string {
  if (arxivId.length < 4) return join(sourcesRoot, arxivId, 'source');
  const yy = arxivId.slice(0, 2);
  const mm = arxivId.slice(2, 4);
  return join(sourcesRoot, yy, mm, arxivId, 'source');
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch { return false; }
}

const SECTION_RE = /^\\section\s*\*?\s*\{/gm;
function countSectionsInTex(content: string): number {
  const m = content.match(SECTION_RE);
  return m ? m.length : 0;
}

interface ParseResult {
  arxivId: string;
  cohort: 'flagged' | 'healthy';
  status: 'parsed' | 'parse_error' | 'no_source';
  error?: string;

  // Local parse output
  rootTex: string | null;
  parserSections: number;
  mergedTexChars: number;
  totalSourceChars: number;
  missingIncludesRaw: number;
  missingIncludesBody: number;
  abstractChars: number;
  referencesCount: number;
  parseDurationMs: number;

  // Derived metrics (matching production quality-metrics.ts:122,153-154)
  rawTextChars: number;          // sum(parsedSection.content.length) + abstract.length
  mergedCoverage: number;        // rawTextChars / mergedTexChars (production formula; <0.5 = sections capture <50% of merged file)
  structureQuality: number;      // 0..1 from missing_body penalty (matches production logic)

  // Reproducible flagging
  wouldFlagReasons: string[];   // among ['low_retention_auto', 'missing_body_N', 'low_merged_coverage']
  wouldFlag: boolean;

  // Production baseline for comparison
  prodFlagged: boolean;
  prodReason: string | null;
  prodSeverity: string | null;
  prodParseQuality: number | null;

  // Diff
  matchesProd: boolean;          // we agree with production verdict
}

async function evaluateDoc(doc: CorpusDoc, sourcesRoot: string): Promise<ParseResult> {
  const sourceDir = arxivLocalPath(sourcesRoot, doc.arxivId);
  const result: ParseResult = {
    arxivId: doc.arxivId,
    cohort: doc.cohort,
    status: 'parsed',
    rootTex: null,
    parserSections: 0,
    mergedTexChars: 0,
    totalSourceChars: 0,
    missingIncludesRaw: 0,
    missingIncludesBody: 0,
    abstractChars: 0,
    referencesCount: 0,
    parseDurationMs: 0,
    rawTextChars: 0,
    mergedCoverage: 0,
    structureQuality: 0,
    wouldFlagReasons: [],
    wouldFlag: false,
    prodFlagged: doc.cohort === 'flagged',
    prodReason: doc.prodReason ?? null,
    prodSeverity: doc.prodSeverity ?? null,
    prodParseQuality: doc.prodParseQuality ?? null,
    matchesProd: false,
  };

  if (!(await dirExists(sourceDir))) {
    result.status = 'no_source';
    return result;
  }

  // Sum total .tex chars in archive (proxy for rawTextChars)
  async function sumTexChars(dir: string): Promise<number> {
    let total = 0;
    async function walk(d: string): Promise<void> {
      let entries;
      try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.isFile() && e.name.endsWith('.tex')) {
          try { total += (await stat(join(d, e.name))).size; } catch { /* ignore */ }
        }
      }
    }
    await walk(dir);
    return total;
  }

  result.totalSourceChars = await sumTexChars(sourceDir);

  try {
    const parsed = await parseLatexSource(sourceDir);
    const stats = parsed.stats;
    const rootTex = stats?.rootTex ?? null;
    const missingAll = stats?.missingIncludes ?? [];
    const missingBody = missingAll.filter(isBodyInclude);
    const merged = stats?.mergedTexChars ?? 0;

    result.rootTex = rootTex;
    result.parserSections = parsed.sections.length;
    result.mergedTexChars = merged;
    result.missingIncludesRaw = missingAll.length;
    result.missingIncludesBody = missingBody.length;
    result.abstractChars = parsed.abstract.length;
    result.referencesCount = parsed.references.length;
    result.parseDurationMs = parsed.parseDurationMs;

    // Production-faithful rawTextChars: sum of parsed section content + abstract
    // (NOT total source file bytes — that was the bug in v1).
    // See packages/ingest/src/lib/quality-metrics.ts:115-120
    const sectionChars = parsed.sections.reduce((sum, s) => sum + (s.content?.length ?? 0), 0);
    const rawTextChars = sectionChars + parsed.abstract.length;
    result.rawTextChars = rawTextChars;

    // Production formula: rawTextChars / mergedTexChars. Capped only on display;
    // raw value < 0.5 fires lowStructureTrigger.
    // See quality-metrics.ts:154
    result.mergedCoverage = merged > 0 ? rawTextChars / merged : 0;

    // structureQuality matches production: 1 - min(missingBodyCount * 0.15, 1)
    // See quality-metrics.ts:146,157
    result.structureQuality = Math.max(0, 1 - Math.min(missingBody.length * 0.15, 1));

    // Apply production triggers (quality-metrics.ts:184-186):
    //   retentionTrigger needs chunks (not available locally) — skip; only 34 cases (0.1%)
    //   missingBodyTrigger:  missingBodyCount >= 3
    //   lowStructureTrigger: mergedCoverage < 0.5 && rawTextChars > 5000
    const missingBodyTrigger = missingBody.length >= 3;
    const lowStructureTrigger = result.mergedCoverage < 0.5 && rawTextChars > 5000;

    if (missingBodyTrigger) result.wouldFlagReasons.push(`missing_body_${missingBody.length}`);
    if (lowStructureTrigger) result.wouldFlagReasons.push('low_merged_coverage');
    result.wouldFlag = result.wouldFlagReasons.length > 0;
  } catch (err) {
    result.status = 'parse_error';
    result.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
    result.wouldFlag = true;
    result.wouldFlagReasons.push('parse_exception');
  }

  // Did we agree with production?
  result.matchesProd = result.wouldFlag === result.prodFlagged;

  return result;
}

async function processInParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (onProgress) onProgress(done, items.length);
  return results;
}

interface CohortSummary {
  cohort: 'flagged' | 'healthy';
  total: number;
  parsed: number;
  parseError: number;
  noSource: number;
  wouldFlag: number;
  matchesProd: number;
  // Average metrics
  avgSections: number;
  avgMergedCoverage: number;
  avgMissingBody: number;
  avgParseMs: number;
}

function summarize(rows: ParseResult[], cohort: 'flagged' | 'healthy'): CohortSummary {
  const c = rows.filter((r) => r.cohort === cohort);
  const parsed = c.filter((r) => r.status === 'parsed');
  return {
    cohort,
    total: c.length,
    parsed: parsed.length,
    parseError: c.filter((r) => r.status === 'parse_error').length,
    noSource: c.filter((r) => r.status === 'no_source').length,
    wouldFlag: c.filter((r) => r.wouldFlag).length,
    matchesProd: c.filter((r) => r.matchesProd).length,
    avgSections: parsed.length ? parsed.reduce((s, r) => s + r.parserSections, 0) / parsed.length : 0,
    avgMergedCoverage: parsed.length ? parsed.reduce((s, r) => s + r.mergedCoverage, 0) / parsed.length : 0,
    avgMissingBody: parsed.length ? parsed.reduce((s, r) => s + r.missingIncludesBody, 0) / parsed.length : 0,
    avgParseMs: parsed.length ? parsed.reduce((s, r) => s + r.parseDurationMs, 0) / parsed.length : 0,
  };
}

function printSummary(s: CohortSummary): void {
  const pct = (n: number) => (s.total > 0 ? (100 * n / s.total).toFixed(1) : '0.0');
  console.error(`\n=== ${s.cohort.toUpperCase()} (n=${s.total}) ===`);
  console.error(`  parsed_ok       : ${s.parsed} (${pct(s.parsed)}%)`);
  console.error(`  parse_error     : ${s.parseError} (${pct(s.parseError)}%)`);
  console.error(`  no_source_dir   : ${s.noSource} (${pct(s.noSource)}%)`);
  console.error(`  would_flag      : ${s.wouldFlag} (${pct(s.wouldFlag)}%)`);
  console.error(`  matches_prod    : ${s.matchesProd} (${pct(s.matchesProd)}%) ← reproducibility`);
  console.error(`  avg_sections    : ${s.avgSections.toFixed(1)}`);
  console.error(`  avg_merged_cov  : ${s.avgMergedCoverage.toFixed(3)}`);
  console.error(`  avg_missing_body: ${s.avgMissingBody.toFixed(2)}`);
  console.error(`  avg_parse_ms    : ${s.avgParseMs.toFixed(1)}`);
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  console.error(`[test-parser-local] config:`, cfg);

  console.error(`[test-parser-local] loading TSVs…`);
  const flagged = await loadFlagged(cfg.flaggedTsv);
  const healthy = await loadHealthy(cfg.healthyTsv);
  console.error(`  flagged: ${flagged.length} | healthy: ${healthy.length}`);

  let all = [...flagged, ...healthy];
  if (cfg.limit > 0) {
    all = all.slice(0, cfg.limit);
    console.error(`  limit=${cfg.limit} applied → evaluating ${all.length} docs`);
  }

  const t0 = Date.now();
  const results = await processInParallel(
    all,
    cfg.concurrency,
    (doc) => evaluateDoc(doc, cfg.sourcesRoot),
    (done, total) => {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const eta = (total - done) / rate;
      console.error(`  [progress] ${done}/${total} (${(100 * done / total).toFixed(1)}%) | ${rate.toFixed(1)} doc/s | ETA ${(eta / 60).toFixed(1)} min`);
    },
  );

  await writeFile(cfg.outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`\n[test-parser-local] wrote ${results.length} rows → ${cfg.outPath}`);
  console.error(`[test-parser-local] elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  printSummary(summarize(results, 'flagged'));
  printSummary(summarize(results, 'healthy'));

  // Quick distribution on flagged: how many of each reason still match
  const flaggedReasons = new Map<string, { hit: number; miss: number }>();
  for (const r of results.filter((x) => x.cohort === 'flagged' && x.prodReason)) {
    const key = r.prodReason!;
    if (!flaggedReasons.has(key)) flaggedReasons.set(key, { hit: 0, miss: 0 });
    if (r.matchesProd) flaggedReasons.get(key)!.hit++;
    else flaggedReasons.get(key)!.miss++;
  }
  console.error(`\n=== flagged reproducibility by prod reason ===`);
  const sortedReasons = [...flaggedReasons.entries()].sort((a, b) => (b[1].hit + b[1].miss) - (a[1].hit + a[1].miss));
  for (const [reason, { hit, miss }] of sortedReasons.slice(0, 10)) {
    const total = hit + miss;
    const pct = (100 * hit / total).toFixed(1);
    console.error(`  ${reason.padEnd(40)} ${hit}/${total} (${pct}%)`);
  }

  // Helper: for each unused field warning suppression
  void basename;
  void countSectionsInTex;
}

main().catch((err) => {
  console.error('[test-parser-local] fatal:', err);
  process.exit(1);
});
