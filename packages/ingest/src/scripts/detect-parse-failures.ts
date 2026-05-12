/**
 * detect-parse-failures — read-only scan over indexed LaTeX documents to
 * surface docs where the parser lost most of the source (catastrophic
 * parse failure). Primary trigger: `\input name` without braces (valid
 * TeX whitespace-delimited syntax) not resolved by the regex in
 * latex-parser.ts:142, causing included .tex files to be skipped.
 *
 * Output row per affected doc (JSONL or CSV):
 *   - source_id, title, parse_quality
 *   - chunks_count, chunks_chars
 *   - source_tex_chars  — sum of char counts over every *.tex in source dir
 *   - source_coverage   — chunks_chars / source_tex_chars (0..N)
 *   - input_no_braces   — whether root tex has `\input name` (space-delim) pattern
 *   - chunk_starts_with_latex — first chunk begins with literal TeX markup
 *   - probable_cause    — "latex_input_no_braces" | "small_content" | "mostly_latex_literal" | "unknown"
 *
 * Output on stdout (JSONL by default). Summary to stderr.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run detect-parse-failures
 *   pnpm --filter @openarx/ingest run detect-parse-failures -- --threshold 0.2
 *   pnpm --filter @openarx/ingest run detect-parse-failures -- --sample 100 --format csv
 *
 * Read-only: zero PG/Qdrant/HTTP writes. Safe to run in parallel with any
 * ingest activity.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, query } from '@openarx/api';
import { arxivDocPath } from '../utils/doc-path.js';

interface Config {
  threshold: number;
  sample: number | null;
  format: 'jsonl' | 'csv';
  inputCheckOnly: boolean;
  verbose: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    const next = args[idx + 1];
    if (next && !next.startsWith('--')) return next;
    return 'true';
  };
  const has = (name: string) => args.includes(name);
  const fmt = (get('--format') ?? 'jsonl') as Config['format'];
  if (fmt !== 'jsonl' && fmt !== 'csv') {
    console.error(`invalid --format ${fmt}, must be jsonl|csv`);
    process.exit(2);
  }
  return {
    threshold: parseFloat(get('--threshold') ?? '0.1'),
    sample: get('--sample') ? parseInt(get('--sample')!, 10) : null,
    format: fmt,
    inputCheckOnly: has('--input-check-only'),
    verbose: has('--verbose'),
  };
}

interface DocRow {
  id: string;
  source_id: string;
  title: string;
  parse_quality: string | null;
}

interface ChunkAgg {
  chunks_count: number;
  chunks_chars: number;
  first_content: string | null;
}

async function fetchLatexDocs(sample: number | null): Promise<DocRow[]> {
  const limit = sample ? `LIMIT ${sample}` : '';
  // Exclude `abstract_only` tier — those intentionally skip full LaTeX parse
  // (license-restricted sources), so small chunks_count + null rootTex are
  // expected, not a parse failure. Only docs that went through the full
  // route (parse → chunk → enrich → embed → index) are candidates here.
  // IMPORTANT: do NOT SELECT structured_content — it's JSONB with potentially
  // multi-MB values per row. At 169K+ rows, pg-client buffers the entire
  // result set into memory and OOMs the node process around ~4 GB. We resolve
  // rootTex per-doc by reading 00README.json (or scanning for \documentclass)
  // inside analyseOne() instead — slow filesystem calls but constant memory.
  const r = await query<DocRow>(
    `SELECT id::text AS id,
            source_id,
            title,
            parse_quality::text AS parse_quality
     FROM documents
     WHERE source_format = 'latex'
       AND status = 'ready'
       AND (indexing_tier IS NULL OR indexing_tier = 'full')
     ORDER BY source_id DESC
     ${limit}`,
  );
  return r.rows;
}

async function fetchChunkAgg(docId: string): Promise<ChunkAgg> {
  const r = await query<{ cnt: string; chars: string | null; first: string | null }>(
    `SELECT COUNT(*)::text AS cnt,
            SUM(LENGTH(content))::text AS chars,
            (SELECT content FROM chunks
               WHERE document_id = $1::uuid
               ORDER BY position ASC LIMIT 1) AS first
     FROM chunks WHERE document_id = $1::uuid`,
    [docId],
  );
  const row = r.rows[0];
  return {
    chunks_count: parseInt(row?.cnt ?? '0', 10),
    chunks_chars: parseInt(row?.chars ?? '0', 10),
    first_content: row?.first ?? null,
  };
}

async function listTexFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        result.push(...(await listTexFiles(full)));
      } else if (e.isFile() && e.name.endsWith('.tex')) {
        result.push(full);
      }
    }
  } catch {
    // Missing dir → empty
  }
  return result;
}

/** Local reimplementation of latex-parser.findRootTex — not exported.
 *  Prefers 00README.json toplevel, falls back to scanning .tex files for
 *  \documentclass. Returns relative path from sourceDir, or null.
 *  Read-only filesystem access. */
async function findRootTexLocal(sourceDir: string, texFiles: string[]): Promise<string | null> {
  // 1. Try 00README.json manifest
  try {
    const raw = await readFile(join(sourceDir, '00README.json'), 'utf-8');
    const manifest = JSON.parse(raw) as {
      sources?: Array<{ usage: string; filename: string }>;
    };
    const toplevel = manifest.sources?.find((s) => s.usage === 'toplevel');
    if (toplevel?.filename) return toplevel.filename;
  } catch {
    // no manifest
  }
  // 2. Scan each .tex for \documentclass
  for (const full of texFiles) {
    try {
      const content = await readFile(full, 'utf-8');
      if (/\\documentclass/.test(content)) {
        return full.startsWith(sourceDir) ? full.slice(sourceDir.length + 1) : full;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** Matches `\input name`, `\include name`, `\subfile name` with space-delim. */
const INPUT_NO_BRACES_RE = /(?<!%[^\n]*)\\(?:input|include|subfile)\s+[A-Za-z][\w./-]*/;
/** Matches `\import{subdir/}{file}` — import.sty pattern, 2 args. */
const IMPORT_RE = /\\import\s*\{[^}]*\}\s*\{[^}]+\}/;
/** Matches `\subimport{subdir/}{file}`. */
const SUBIMPORT_RE = /\\subimport\s*\{[^}]*\}\s*\{[^}]+\}/;
/** Count real `\section{...}` (not `\section*`) across source — proxy for
 *  expected number of top-level sections the parser should have found. */
const SECTION_CMD_RE = /\\section\s*\*?\s*\{/g;

/** Chunk preview starts with raw TeX primitives → parser lost structure. */
const LATEX_LITERAL_START_RE =
  /^\s*\\(?:maketitle|begin\{(?:abstract|keywords|document)\}|input|include|subfile|section|subsection)\b/;

/** Classification priority: most-specific first. Earlier match wins.
 *  Labels are coarse buckets that map to bd issues — goal is to turn
 *  the previous ~1587 'unknown' pile into named causes. */
function classify(opts: {
  coverage: number;
  chunks_count: number;
  input_no_braces: boolean;
  chunk_starts_with_latex: boolean;
  has_import: boolean;
  has_subimport: boolean;
  source_sections: number;
  parser_sections: number;
}): string {
  // 1. chunks=0 with non-trivial source → pipeline silent-empty (panb)
  if (opts.chunks_count === 0) return 'parse_empty_result';

  // 2. Smoking-gun include patterns anywhere in source
  if (opts.has_import) return 'latex_import_unresolved';
  if (opts.has_subimport) return 'latex_subimport_unresolved';
  if (opts.input_no_braces) return 'latex_input_no_braces';

  // 3. Chunks start with raw TeX → parser lost structure even though content was there
  if (opts.chunk_starts_with_latex) return 'mostly_latex_literal';

  // 4. Source has many \section, parser returned few → section detection failed
  //    Threshold: source has ≥4 sections but parser got ≤half.
  if (opts.source_sections >= 4 && opts.parser_sections <= Math.floor(opts.source_sections / 2)) {
    return 'parser_section_undercount';
  }

  // 5. Few chunks overall, low coverage → short doc OR findRootTex picked wrong
  if (opts.chunks_count <= 3 && opts.coverage < 0.1) return 'small_content';

  // 6. Moderate chunks, low coverage, no obvious include bug → heavy markup
  //    (math / tables / figures stripped) OR stripCommands too aggressive.
  return 'content_stripped';
}

interface Report {
  source_id: string;
  title: string;
  parse_quality: number | null;
  chunks_count: number;
  chunks_chars: number;
  source_tex_chars: number;
  source_coverage: number;
  root_tex: string | null;
  input_no_braces: boolean;
  has_import: boolean;
  has_subimport: boolean;
  source_sections: number;
  parser_sections: number;
  chunk_starts_with_latex: boolean;
  probable_cause: string;
}

async function fetchParserSectionsCount(docId: string): Promise<number> {
  // Per-doc query instead of bulk SELECT (structured_content can be
  // multi-MB per row; bulk would OOM on 169K-doc scan).
  const r = await query<{ n: string | null }>(
    `SELECT jsonb_array_length(structured_content->'sections')::text AS n
     FROM documents WHERE id = $1::uuid`,
    [docId],
  );
  return r.rows[0]?.n ? parseInt(r.rows[0]!.n!, 10) : 0;
}

/** Upper-bound per-file size before we skip pattern scans. Most LaTeX files
 *  are <200 KB; huge outliers (generated .bbl, pre-rendered tables) waste
 *  regex time and RAM for little signal. */
const MAX_READ_FILE_BYTES = 2_000_000;

async function analyseOne(doc: DocRow): Promise<Report | null> {
  const sourceDir = join(arxivDocPath(doc.source_id), 'source');
  const texFiles = await listTexFiles(sourceDir);
  if (texFiles.length === 0) return null;

  // Walk all .tex files in one pass: accumulate size, scan each for
  // include-pattern smoking guns and \section counts. Reading content
  // anyway; combining avoids a second pass.
  let sourceTexChars = 0;
  let hasImport = false;
  let hasSubimport = false;
  let inputNoBracesAny = false;
  let sourceSections = 0;
  for (const f of texFiles) {
    try {
      const s = await stat(f);
      sourceTexChars += s.size;
      if (s.size > MAX_READ_FILE_BYTES) continue;
      const content = await readFile(f, 'utf-8');
      if (!hasImport && IMPORT_RE.test(content)) hasImport = true;
      if (!hasSubimport && SUBIMPORT_RE.test(content)) hasSubimport = true;
      if (!inputNoBracesAny && INPUT_NO_BRACES_RE.test(content)) inputNoBracesAny = true;
      const sectionMatches = content.match(SECTION_CMD_RE);
      if (sectionMatches) sourceSections += sectionMatches.length;
    } catch {
      // ignore
    }
  }
  if (sourceTexChars === 0) return null;

  const agg = await fetchChunkAgg(doc.id);
  const coverage = agg.chunks_chars / sourceTexChars;

  const rootTex = await findRootTexLocal(sourceDir, texFiles);

  const parserSections = await fetchParserSectionsCount(doc.id);

  const firstChunk = agg.first_content ?? '';
  const chunkStartsWithLatex = LATEX_LITERAL_START_RE.test(firstChunk.slice(0, 200));

  const probableCause = classify({
    coverage,
    chunks_count: agg.chunks_count,
    input_no_braces: inputNoBracesAny,
    chunk_starts_with_latex: chunkStartsWithLatex,
    has_import: hasImport,
    has_subimport: hasSubimport,
    source_sections: sourceSections,
    parser_sections: parserSections,
  });

  return {
    source_id: doc.source_id,
    title: doc.title,
    parse_quality: doc.parse_quality ? parseFloat(doc.parse_quality) : null,
    chunks_count: agg.chunks_count,
    chunks_chars: agg.chunks_chars,
    source_tex_chars: sourceTexChars,
    source_coverage: Number(coverage.toFixed(4)),
    root_tex: rootTex,
    input_no_braces: inputNoBracesAny,
    has_import: hasImport,
    has_subimport: hasSubimport,
    source_sections: sourceSections,
    parser_sections: parserSections,
    chunk_starts_with_latex: chunkStartsWithLatex,
    probable_cause: probableCause,
  };
}

function emitHeader(cfg: Config): void {
  if (cfg.format !== 'csv') return;
  console.log(
    [
      'source_id',
      'title',
      'parse_quality',
      'chunks_count',
      'chunks_chars',
      'source_tex_chars',
      'source_coverage',
      'root_tex',
      'input_no_braces',
      'has_import',
      'has_subimport',
      'source_sections',
      'parser_sections',
      'chunk_starts_with_latex',
      'probable_cause',
    ].join(','),
  );
}

function emitRow(cfg: Config, r: Report): void {
  if (cfg.format === 'jsonl') {
    console.log(JSON.stringify(r));
    return;
  }
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  console.log(
    [
      r.source_id,
      esc(r.title ?? ''),
      r.parse_quality ?? '',
      r.chunks_count,
      r.chunks_chars,
      r.source_tex_chars,
      r.source_coverage,
      esc(r.root_tex ?? ''),
      r.input_no_braces,
      r.has_import,
      r.has_subimport,
      r.source_sections,
      r.parser_sections,
      r.chunk_starts_with_latex,
      r.probable_cause,
    ].join(','),
  );
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  console.error(
    `[detect-parse-failures] config: threshold=${cfg.threshold} sample=${cfg.sample ?? 'all'} ` +
    `format=${cfg.format} input_check_only=${cfg.inputCheckOnly}`,
  );

  const docs = await fetchLatexDocs(cfg.sample);
  console.error(`[detect-parse-failures] scanning ${docs.length} latex docs`);

  emitHeader(cfg);

  let scanned = 0;
  let affected = 0;
  const causeCounts: Record<string, number> = {};
  const minCoverage = { value: Infinity, sourceId: '' };
  const t0 = Date.now();

  for (const doc of docs) {
    scanned++;
    if (scanned % 500 === 0) {
      console.error(
        `[detect-parse-failures] progress: ${scanned}/${docs.length} scanned, ${affected} affected`,
      );
    }
    try {
      const report = await analyseOne(doc);
      if (!report) continue;

      if (report.source_coverage < minCoverage.value) {
        minCoverage.value = report.source_coverage;
        minCoverage.sourceId = report.source_id;
      }

      const isAffected = cfg.inputCheckOnly
        ? report.input_no_braces
        : report.source_coverage < cfg.threshold;

      if (isAffected) {
        affected++;
        causeCounts[report.probable_cause] = (causeCounts[report.probable_cause] ?? 0) + 1;
        emitRow(cfg, report);
      } else if (cfg.verbose) {
        emitRow(cfg, report);
      }
    } catch (err) {
      console.error(
        `[detect-parse-failures] skip ${doc.source_id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error('');
  console.error(`[detect-parse-failures] scan complete in ${elapsed}s`);
  console.error(`  scanned: ${scanned}`);
  console.error(`  affected (coverage < ${cfg.threshold}): ${affected}`);
  console.error(`  breakdown by probable_cause:`);
  for (const [cause, n] of Object.entries(causeCounts).sort((a, b) => b[1] - a[1])) {
    console.error(`    ${cause.padEnd(26)} ${n}`);
  }
  if (minCoverage.sourceId) {
    console.error(
      `  min_coverage: ${minCoverage.value.toFixed(4)} at source_id=${minCoverage.sourceId}`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[detect-parse-failures] fatal:', err);
  process.exit(1);
});
