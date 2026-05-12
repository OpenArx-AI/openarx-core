#!/usr/bin/env tsx
/**
 * Parser validation orchestrator (M0).
 *
 * Runs each downloaded sample paper through GROBID and Docling,
 * compares results, outputs validation-report.json + ASCII summary.
 *
 * Usage: pnpm --filter @openarx/ingest run validate-parsers
 *
 * Environment variables:
 *   GROBID_URL   — default http://localhost:8070
 *   DOCLING_URL  — default http://localhost:5001
 */

import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArxivPaperMetadata,
  PaperComparison,
  ComparisonMetrics,
  ParserResult,
  ValidationReport,
  ValidationSummary,
  ParsedDocument,
} from '@openarx/types';
import { parseWithGrobid, checkGrobidHealth } from '../parsers/grobid-client.js';
import { parseWithDocling, checkDoclingHealth } from '../parsers/docling-client.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('validate');

const SAMPLES_DIR = join(process.cwd(), '../../data/samples/arxiv');
const REPORT_PATH = join(process.cwd(), '../../data/samples/validation-report.json');

const GROBID_URL = process.env.GROBID_URL ?? 'http://localhost:8070';
const DOCLING_URL = process.env.DOCLING_URL ?? 'http://localhost:5001';

interface ParserDef {
  name: string;
  healthy: boolean;
  parse: (pdfPath: string) => Promise<ParsedDocument>;
}

// ── Main ──

async function main(): Promise<void> {
  log.info('Starting parser validation');

  // 1. Check which parsers are available
  const parsers = await checkParsers();
  const available = parsers.filter((p) => p.healthy);

  if (available.length === 0) {
    log.fatal('No parsers available. Start GROBID and/or Docling first.');
    process.exit(1);
  }

  log.info({ parsers: available.map((p) => p.name) }, 'Available parsers');

  // 2. Scan for downloaded papers
  const papers = await scanPapers();
  if (papers.length === 0) {
    log.fatal('No papers found. Run download-samples first.');
    process.exit(1);
  }

  log.info({ count: papers.length }, 'Papers found');

  // 3. Run validation
  const comparisons: PaperComparison[] = [];

  for (const paper of papers) {
    log.info({ arxivId: paper.arxivId, title: paper.title }, 'Validating paper');

    const results: ParserResult[] = [];
    for (const parser of available) {
      const result = await runParser(parser, paper.pdfPath);
      results.push(result);
    }

    const comparison = buildComparison(paper, results);
    comparisons.push(comparison);
  }

  // 4. Generate report
  const summary = buildSummary(comparisons, available.map((p) => p.name));
  const report: ValidationReport = {
    generatedAt: new Date().toISOString(),
    papers: comparisons,
    summary,
  };

  await mkdir(join(REPORT_PATH, '..'), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  log.info({ path: REPORT_PATH }, 'Report written');

  // 5. Print ASCII summary
  printSummary(report);
}

// ── Parser checks ──

async function checkParsers(): Promise<ParserDef[]> {
  const [grobidOk, doclingOk] = await Promise.all([
    checkGrobidHealth(GROBID_URL),
    checkDoclingHealth(DOCLING_URL),
  ]);

  log.info({ grobid: grobidOk, docling: doclingOk }, 'Health check results');

  return [
    {
      name: 'grobid',
      healthy: grobidOk,
      parse: (pdfPath: string) =>
        parseWithGrobid(pdfPath, { baseUrl: GROBID_URL, retry: { maxAttempts: 1 } }),
    },
    {
      name: 'docling',
      healthy: doclingOk,
      parse: (pdfPath: string) =>
        parseWithDocling(pdfPath, { baseUrl: DOCLING_URL, retry: { maxAttempts: 1 } }),
    },
  ];
}

// ── Paper scanning ──

interface PaperInfo {
  arxivId: string;
  title: string;
  pdfPath: string;
  hasLatexSource: boolean;
  metadata: ArxivPaperMetadata;
}

async function scanPapers(): Promise<PaperInfo[]> {
  let dirs: string[];
  try {
    dirs = await readdir(SAMPLES_DIR);
  } catch {
    return [];
  }

  const papers: PaperInfo[] = [];

  for (const dir of dirs.sort()) {
    const paperDir = join(SAMPLES_DIR, dir);
    const metaPath = join(paperDir, 'metadata.json');
    const pdfPath = join(paperDir, 'paper.pdf');

    try {
      await access(metaPath);
      await access(pdfPath);
    } catch {
      continue;
    }

    const metaJson = await readFile(metaPath, 'utf-8');
    const metadata = JSON.parse(metaJson) as ArxivPaperMetadata;

    let hasLatexSource = false;
    try {
      await access(join(paperDir, 'source.tar.gz'));
      hasLatexSource = true;
    } catch {
      // no latex source
    }

    papers.push({
      arxivId: metadata.arxivId,
      title: metadata.title,
      pdfPath,
      hasLatexSource,
      metadata,
    });
  }

  return papers;
}

// ── Parser execution ──

async function runParser(parser: ParserDef, pdfPath: string): Promise<ParserResult> {
  try {
    const document = await parser.parse(pdfPath);
    return { parser: parser.name, success: true, document };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ parser: parser.name, pdfPath, err: message }, 'Parser failed');
    return { parser: parser.name, success: false, error: message };
  }
}

// ── Comparison ──

function buildComparison(paper: PaperInfo, results: ParserResult[]): PaperComparison {
  const metrics: ComparisonMetrics = {
    sectionCount: {},
    referenceCount: {},
    tableCount: {},
    formulaCount: {},
    titleMatch: {},
    abstractMatch: {},
    parseDurationMs: {},
  };

  for (const r of results) {
    if (!r.success || !r.document) continue;
    const d = r.document;

    metrics.sectionCount[r.parser] = d.sections.length;
    metrics.referenceCount[r.parser] = d.references.length;
    metrics.tableCount[r.parser] = d.tables.length;
    metrics.formulaCount[r.parser] = d.formulas.length;
    metrics.parseDurationMs[r.parser] = d.parseDurationMs;

    // Title match: fuzzy — check if parsed title contains significant portion of arXiv title
    metrics.titleMatch[r.parser] = fuzzyMatch(d.title, paper.metadata.title);

    // Abstract match: check overlap
    metrics.abstractMatch[r.parser] =
      paper.metadata.abstract.length > 0 && d.abstract.length > 20
        ? fuzzyMatch(d.abstract, paper.metadata.abstract)
        : false;
  }

  return {
    arxivId: paper.arxivId,
    title: paper.title,
    pdfPath: paper.pdfPath,
    hasLatexSource: paper.hasLatexSource,
    results,
    comparison: metrics,
  };
}

function fuzzyMatch(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const na = normalize(a);
  const nb = normalize(b);

  if (na.length === 0 || nb.length === 0) return false;

  // Check if one contains a significant portion of the other
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;

  // Use word overlap ratio
  const wordsShort = new Set(shorter.split(' '));
  const wordsLong = new Set(longer.split(' '));
  const overlap = [...wordsShort].filter((w) => wordsLong.has(w) && w.length > 2).length;
  const ratio = overlap / Math.max(wordsShort.size, 1);

  return ratio >= 0.5;
}

// ── Summary ──

function buildSummary(papers: PaperComparison[], parserNames: string[]): ValidationSummary {
  const perParser: ValidationSummary['perParser'] = {};

  for (const name of parserNames) {
    const successes = papers.filter((p) =>
      p.results.some((r) => r.parser === name && r.success),
    );
    const failures = papers.filter((p) =>
      p.results.some((r) => r.parser === name && !r.success),
    );

    const avg = (key: keyof ComparisonMetrics) => {
      const values = successes
        .map((p) => {
          const v = p.comparison[key][name];
          return typeof v === 'number' ? v : undefined;
        })
        .filter((v): v is number => v !== undefined);
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    };

    const matchRate = (key: 'titleMatch' | 'abstractMatch') => {
      const values = successes.map((p) => p.comparison[key][name]).filter((v) => v !== undefined);
      return values.length > 0 ? values.filter(Boolean).length / values.length : 0;
    };

    perParser[name] = {
      successCount: successes.length,
      failCount: failures.length,
      avgSections: Math.round(avg('sectionCount') * 10) / 10,
      avgReferences: Math.round(avg('referenceCount') * 10) / 10,
      avgTables: Math.round(avg('tableCount') * 10) / 10,
      avgFormulas: Math.round(avg('formulaCount') * 10) / 10,
      avgDurationMs: Math.round(avg('parseDurationMs')),
      titleMatchRate: Math.round(matchRate('titleMatch') * 100) / 100,
      abstractMatchRate: Math.round(matchRate('abstractMatch') * 100) / 100,
    };
  }

  // Generate recommendation
  const recommendation = generateRecommendation(perParser, parserNames);

  return {
    totalPapers: papers.length,
    parsersCompared: parserNames,
    perParser,
    recommendation,
  };
}

function generateRecommendation(
  perParser: ValidationSummary['perParser'],
  names: string[],
): string {
  if (names.length < 2) {
    return `Only ${names[0]} was available for testing. Run both parsers for comparison.`;
  }

  const lines: string[] = [];
  const [a, b] = names;
  const sa = perParser[a];
  const sb = perParser[b];

  if (sa.successCount > sb.successCount) {
    lines.push(`${a} had higher success rate (${sa.successCount} vs ${sb.successCount}).`);
  } else if (sb.successCount > sa.successCount) {
    lines.push(`${b} had higher success rate (${sb.successCount} vs ${sa.successCount}).`);
  }

  if (sa.avgReferences > sb.avgReferences * 1.2) {
    lines.push(`${a} extracted more references on average (${sa.avgReferences} vs ${sb.avgReferences}).`);
  } else if (sb.avgReferences > sa.avgReferences * 1.2) {
    lines.push(`${b} extracted more references on average (${sb.avgReferences} vs ${sa.avgReferences}).`);
  }

  if (sa.titleMatchRate > sb.titleMatchRate) {
    lines.push(`${a} matched titles better (${sa.titleMatchRate * 100}% vs ${sb.titleMatchRate * 100}%).`);
  } else if (sb.titleMatchRate > sa.titleMatchRate) {
    lines.push(`${b} matched titles better (${sb.titleMatchRate * 100}% vs ${sa.titleMatchRate * 100}%).`);
  }

  if (sa.avgDurationMs < sb.avgDurationMs * 0.7) {
    lines.push(`${a} was significantly faster (${sa.avgDurationMs}ms vs ${sb.avgDurationMs}ms avg).`);
  } else if (sb.avgDurationMs < sa.avgDurationMs * 0.7) {
    lines.push(`${b} was significantly faster (${sb.avgDurationMs}ms vs ${sa.avgDurationMs}ms avg).`);
  }

  if (lines.length === 0) {
    lines.push('Both parsers performed similarly. Review per-paper results for edge cases.');
  }

  return lines.join(' ');
}

// ── ASCII output ──

function printSummary(report: ValidationReport): void {
  const { summary, papers } = report;
  const names = summary.parsersCompared;

  console.log('\n' + '='.repeat(80));
  console.log('  PARSER VALIDATION REPORT');
  console.log('='.repeat(80));
  console.log(`  Papers: ${summary.totalPapers}  |  Parsers: ${names.join(', ')}`);
  console.log('-'.repeat(80));

  // Per-parser summary table
  const header = padRight('Metric', 22) + names.map((n) => padRight(n, 14)).join('');
  console.log(header);
  console.log('-'.repeat(22 + names.length * 14));

  const rows: [string, (name: string) => string][] = [
    ['Success', (n) => `${summary.perParser[n].successCount}/${summary.totalPapers}`],
    ['Avg Sections', (n) => String(summary.perParser[n].avgSections)],
    ['Avg References', (n) => String(summary.perParser[n].avgReferences)],
    ['Avg Tables', (n) => String(summary.perParser[n].avgTables)],
    ['Avg Formulas', (n) => String(summary.perParser[n].avgFormulas)],
    ['Avg Duration (ms)', (n) => String(summary.perParser[n].avgDurationMs)],
    ['Title Match Rate', (n) => `${summary.perParser[n].titleMatchRate * 100}%`],
    ['Abstract Match Rate', (n) => `${summary.perParser[n].abstractMatchRate * 100}%`],
  ];

  for (const [label, fn] of rows) {
    const line = padRight(label, 22) + names.map((n) => padRight(fn(n), 14)).join('');
    console.log(line);
  }

  // Per-paper detail (compact)
  console.log('\n' + '-'.repeat(80));
  console.log('  PER-PAPER RESULTS');
  console.log('-'.repeat(80));

  const detailHeader =
    padRight('Paper', 20) +
    names.flatMap((n) => [padRight(`${n}:sec`, 8), padRight('ref', 6), padRight('ok', 4)]).join('');
  console.log(detailHeader);

  for (const paper of papers) {
    const id = paper.arxivId.length > 18 ? paper.arxivId.slice(0, 18) + '..' : paper.arxivId;
    let line = padRight(id, 20);

    for (const name of names) {
      const result = paper.results.find((r) => r.parser === name);
      if (!result || !result.success || !result.document) {
        line += padRight('FAIL', 8) + padRight('-', 6) + padRight('-', 4);
      } else {
        line += padRight(String(result.document.sections.length), 8);
        line += padRight(String(result.document.references.length), 6);
        line += padRight(paper.comparison.titleMatch[name] ? 'Y' : 'N', 4);
      }
    }

    console.log(line);
  }

  // Recommendation
  console.log('\n' + '='.repeat(80));
  console.log('  RECOMMENDATION');
  console.log('-'.repeat(80));
  console.log('  ' + summary.recommendation);
  console.log('='.repeat(80) + '\n');
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

main().catch((err) => {
  log.fatal(err, 'Validation script failed');
  process.exit(1);
});
