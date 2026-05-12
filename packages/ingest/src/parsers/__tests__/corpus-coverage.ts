#!/usr/bin/env tsx
/**
 * LaTeX parser corpus regression harness.
 *
 * Runs the parser against every doc in `docs/parse-failures/test-corpus/`
 * and checks each result against `expected.json`. Pass/fail criteria are
 * tolerant (±2 sections, basename match for root, case-insensitive name
 * containment) — we're catching regressions, not enforcing byte parity.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx src/parsers/__tests__/corpus-coverage.ts
 *
 * Optional: pass a corpus root path to override the default.
 *   pnpm ... corpus-coverage.ts /path/to/my-corpus
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseLatexSource, findRootTex } from '../latex-parser.js';

const DEFAULT_CORPUS_ROOT = '/home/wlad/Projects/openarx/docs/parse-failures/test-corpus';

interface Expected {
  correct_root_tex?: string | null;
  wrong_root_picked?: string;
  expected_sections_min?: number | null;
  expected_sections_exact?: number;
  expected_section_names_prefix?: string[];
  expected_section_names_includes?: string[];
  expected_section_names_excludes?: string[];
  diagnosis: string;
  notes?: string;
}

interface RunResult {
  source_id: string;
  diagnosis: string;
  root: string | null;
  sections: number;
  abstract_chars: number;
  section_names: string[];
  elapsed_ms: number;
  error?: string;
  pass: boolean;
  fail_reason?: string;
  expected: Expected;
}

function checkPass(
  expected: Expected,
  rootTex: string | null,
  sections: number,
  sectionNames: string[],
): { pass: boolean; reason?: string } {
  if (expected.wrong_root_picked && rootTex === expected.wrong_root_picked) {
    return { pass: false, reason: `picked wrong root ${rootTex}` };
  }
  if (expected.correct_root_tex != null && rootTex !== expected.correct_root_tex) {
    const expectedBase = basename(expected.correct_root_tex);
    const actualBase = rootTex ? basename(rootTex) : '';
    if (expectedBase !== actualBase) {
      return { pass: false, reason: `root mismatch: want ${expected.correct_root_tex}, got ${rootTex}` };
    }
  }
  if (expected.expected_sections_min != null && sections < expected.expected_sections_min) {
    return { pass: false, reason: `sections=${sections} < min ${expected.expected_sections_min}` };
  }
  if (expected.expected_sections_exact != null) {
    const diff = Math.abs(sections - expected.expected_sections_exact);
    if (diff > 2) {
      return { pass: false, reason: `sections=${sections} differ from exact ${expected.expected_sections_exact} by ${diff}` };
    }
  }
  if (expected.expected_section_names_prefix && expected.expected_section_names_prefix.length > 0) {
    for (let i = 0; i < expected.expected_section_names_prefix.length && i < sectionNames.length; i++) {
      const exp = expected.expected_section_names_prefix[i].toLowerCase();
      const got = sectionNames[i].toLowerCase();
      if (!got.includes(exp) && !exp.includes(got)) {
        return { pass: false, reason: `section[${i}] name mismatch: want "${expected.expected_section_names_prefix[i]}", got "${sectionNames[i]}"` };
      }
    }
  }
  if (expected.expected_section_names_excludes) {
    for (const bad of expected.expected_section_names_excludes) {
      if (sectionNames.some((n) => n.toLowerCase().includes(bad.toLowerCase()))) {
        return { pass: false, reason: `has excluded section "${bad}"` };
      }
    }
  }
  return { pass: true };
}

async function runOne(corpusRoot: string, categoryDir: string, sourceId: string): Promise<RunResult | null> {
  const docDir = join(corpusRoot, categoryDir, sourceId);
  const expectedPath = join(docDir, 'expected.json');
  let expected: Expected;
  try {
    expected = JSON.parse(await readFile(expectedPath, 'utf-8'));
  } catch {
    return null;
  }

  const r: RunResult = {
    source_id: sourceId,
    diagnosis: expected.diagnosis,
    root: null, sections: 0, abstract_chars: 0, section_names: [], elapsed_ms: 0,
    expected, pass: false,
  };

  const t = Date.now();
  try {
    r.root = await findRootTex(docDir);
    const parsed = await parseLatexSource(docDir);
    r.elapsed_ms = Date.now() - t;
    r.sections = parsed.sections?.length ?? 0;
    r.section_names = (parsed.sections ?? []).map((s) => s.name);
    r.abstract_chars = (parsed.abstract ?? '').length;
  } catch (err) {
    r.elapsed_ms = Date.now() - t;
    r.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }

  const check = r.error ? { pass: false, reason: r.error }
    : checkPass(expected, r.root, r.sections, r.section_names);
  r.pass = check.pass;
  r.fail_reason = check.reason;

  return r;
}

async function main(): Promise<void> {
  const corpusRoot = process.argv[2] ?? DEFAULT_CORPUS_ROOT;
  const categories = await readdir(corpusRoot, { withFileTypes: true });
  const results: RunResult[] = [];

  for (const cat of categories) {
    if (!cat.isDirectory()) continue;
    const sids = await readdir(join(corpusRoot, cat.name), { withFileTypes: true });
    for (const sid of sids) {
      if (!sid.isDirectory()) continue;
      const r = await runOne(corpusRoot, cat.name, sid.name);
      if (r) results.push(r);
    }
  }

  const byDiag = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = r.diagnosis;
    if (!byDiag.has(key)) byDiag.set(key, []);
    byDiag.get(key)!.push(r);
  }

  console.log('\n=== Per-diagnosis coverage ===');
  console.log('Category                           Count  pass');
  const order = ['D0-control', 'D1', 'D2', 'D3', 'D5', 'D6', 'D7', 'D7-but-files-present', 'D8', 'control-works'];
  const sortedKeys = [...byDiag.keys()].sort((a, b) => {
    const ai = order.indexOf(a); const bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  for (const diag of sortedKeys) {
    const rows = byDiag.get(diag)!;
    const p = rows.filter((r) => r.pass).length;
    console.log(`  ${diag.padEnd(34)} ${String(rows.length).padStart(4)}   ${String(p).padStart(4)}/${rows.length}`);
  }

  console.log('\n=== Per-document detail ===');
  for (const r of results.sort((a, b) => a.diagnosis.localeCompare(b.diagnosis) || a.source_id.localeCompare(b.source_id))) {
    const mark = r.pass ? '✓' : '✗';
    console.log(
      `  [${r.diagnosis.padEnd(18)}] ${r.source_id} ` +
      `${mark}(sec=${r.sections},${r.elapsed_ms}ms)` +
      (r.fail_reason ? ` | ${r.fail_reason.slice(0, 120)}` : '')
    );
  }

  const total = results.filter((r) => r.pass).length;
  const avgMs = results.reduce((s, r) => s + r.elapsed_ms, 0) / results.length;

  console.log(`\n=== Total ===`);
  console.log(`  pass: ${total}/${results.length} (${(100*total/results.length).toFixed(0)}%)  avg ${avgMs.toFixed(0)}ms/doc`);

  const outPath = '/tmp/corpus-coverage-results.json';
  const fs = await import('node:fs/promises');
  await fs.writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results → ${outPath}`);

  if (total < results.length) process.exit(1);
}

main().catch((err) => {
  console.error('harness error:', err);
  process.exit(1);
});
