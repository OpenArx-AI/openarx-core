/**
 * Parse strategy selector — routes documents to the appropriate parser.
 *
 * Strategy interface: parse(document, context) → ParsedDocument
 * - LatexStrategy: LaTeX source → stripped text → ParsedDocument
 * - PdfStrategy: PDF → GROBID (+ Mathpix fallback) → ParsedDocument
 *
 * Selector: by document.sourceFormat. LaTeX falls back to PDF on error.
 */

import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Document, ParsedDocument, PipelineContext, ParsedSection } from '@openarx/types';
import { parseLatexSource } from './latex-parser.js';
import { ParserStep } from '../pipeline/parser-step.js';
import { parseWithMathpix } from './mathpix-parser.js';
import { parseMarkdownFile } from './markdown-parser.js';
import { createChildLogger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Returns true iff the directory exists AND has at least one entry. Used as
 * the lazy-extract guard: if the materialized `source/` is already present
 * (legacy doc, or just-extracted by a prior attempt), parsing reads from it
 * directly; otherwise we extract the sibling `eprint` archive first.
 */
async function dirIsNonEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch {
    return false;
  }
}

const log = createChildLogger('parse-strategy');

// Guards
const GUARD_MAX_PDF_BYTES = parseInt(process.env.GUARD_MAX_PDF_MB ?? '200', 10) * 1024 * 1024;
const GUARD_MAX_TEXT_CHARS = parseInt(process.env.GUARD_MAX_TEXT_CHARS ?? '500000', 10);
const GUARD_MAX_MATHPIX_PAGES = parseInt(process.env.GUARD_MAX_MATHPIX_PAGES ?? '50', 10);
const GUARD_MAX_TEX_CHARS = parseInt(process.env.GUARD_MAX_TEX_CHARS ?? '500000', 10);

// ─── Strategy interface ────────────────────────────────────

export interface ParseStrategy {
  name: string;
  parse(document: Document, context: PipelineContext): Promise<ParsedDocument>;
}

// ─── LaTeX Strategy ────────────────────────────────────────

export class LatexStrategy implements ParseStrategy {
  name = 'latex';

  async parse(document: Document, context: PipelineContext): Promise<ParsedDocument> {
    const latexSource = document.sources?.latex;
    if (!latexSource?.path) {
      throw new Error('No LaTeX source path');
    }

    // Lazy-extract policy (openarx-yvkp): ingest no longer persists source/
    // alongside eprint. Here we ensure source/ exists for parsing — either
    // it's already there (legacy or just-extracted) or we extract eprint
    // ourselves. Either way, after parsing we delete source/ so storagebox
    // doesn't accumulate near-duplicates of eprint (~4 TB reclaim).
    const sourceDir = latexSource.path;
    const eprintPath = join(dirname(sourceDir), 'eprint');

    const alreadyPresent = await dirIsNonEmpty(sourceDir);
    if (!alreadyPresent) {
      try {
        await mkdir(sourceDir, { recursive: true });
        await execFileAsync('tar', ['xzf', eprintPath, '-C', sourceDir]);
        context.logger.info(`Lazy-extracted ${eprintPath} → ${sourceDir}`);
      } catch (err) {
        // Cleanup an empty/half-extracted dir before bubbling the error.
        await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
        throw new Error(
          `Failed to extract eprint for LaTeX parse: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      const parsed = await parseLatexSource(sourceDir, latexSource.rootTex);

      // Guard: text size check
      const totalChars = countTextChars(parsed.sections);
      if (totalChars > GUARD_MAX_TEX_CHARS) {
        throw new Error(`text_exceeded: LaTeX text ${totalChars} chars (limit ${GUARD_MAX_TEX_CHARS})`);
      }

      context.logger.info(`LaTeX parse complete: ${parsed.sections.length} sections, ${parsed.references.length} refs, ${parsed.formulas.length} formulas`);
      return parsed;
    } finally {
      // Cleanup source/ unconditionally — keep eprint as the canonical archive.
      // Guard: only delete if eprint is still accessible (defensive: never leave
      // the doc with neither archive nor extracted source).
      try {
        await access(eprintPath);
        await rm(sourceDir, { recursive: true, force: true });
        context.logger.debug(`Cleaned up ${sourceDir} (eprint retained)`);
      } catch {
        context.logger.warn(`Skipping cleanup of ${sourceDir} — eprint missing or inaccessible`);
      }
    }
  }
}

// ─── PDF Strategy (GROBID + Mathpix fallback) ──────────────

export class PdfStrategy implements ParseStrategy {
  name = 'pdf';
  private readonly parserStep: ParserStep;

  constructor(parserStep: ParserStep) {
    this.parserStep = parserStep;
  }

  async parse(document: Document, context: PipelineContext): Promise<ParsedDocument> {
    // Guard 1: PDF size
    const pdfStat = await stat(document.rawContentPath);
    if (pdfStat.size > GUARD_MAX_PDF_BYTES) {
      throw new Error(`size_exceeded: PDF is ${(pdfStat.size / 1024 / 1024).toFixed(1)}MB (limit ${GUARD_MAX_PDF_BYTES / 1024 / 1024}MB)`);
    }

    // Parse with GROBID (Docling fallback removed — GROBID with retry+timeout
    // handles 99%+ of PDFs; Docling output quality was lower anyway)
    let parsed = await this.parserStep.process(
      { pdfPath: document.rawContentPath, document },
      context,
    );

    // Mathpix fallback for math-heavy papers.
    //
    // MATHPIX_DISABLE=1 short-circuits the call without removing the API
    // credentials — same pattern as ENRICHMENT_DISABLE_CORE. Used when the
    // operator wants to temporarily turn Mathpix off (cost spike, API
    // outage, account billing block) while keeping MATHPIX_APP_ID/KEY
    // available for easy re-enable.
    const mathDensity = estimateMathDensity(parsed.sections);
    const grobidTextChars = countTextChars(parsed.sections);
    if (mathDensity > 0.3 && process.env.MATHPIX_APP_ID && process.env.MATHPIX_DISABLE === '1') {
      context.logger.info(`Math-heavy paper (density=${mathDensity.toFixed(2)}) — Mathpix disabled via MATHPIX_DISABLE=1, using GROBID output as-is`);
    } else if (mathDensity > 0.3 && process.env.MATHPIX_APP_ID && process.env.MATHPIX_DISABLE !== '1') {
      if (grobidTextChars > GUARD_MAX_TEXT_CHARS) {
        context.logger.warn(`Skipping Mathpix: GROBID text too large (${grobidTextChars} chars)`);
      } else {
        const pageCount = await countPdfPages(document.rawContentPath);
        if (pageCount > GUARD_MAX_MATHPIX_PAGES) {
          context.logger.warn(`Skipping Mathpix: PDF has ${pageCount} pages (limit ${GUARD_MAX_MATHPIX_PAGES})`);
        } else {
          try {
            context.logger.info(`Math-heavy paper (density=${mathDensity.toFixed(2)}, ${pageCount} pages), re-parsing with Mathpix`);
            const mathStart = performance.now();
            const { parsed: mathpixParsed, numPages } = await parseWithMathpix(document.rawContentPath);
            const durationMs = Math.round(performance.now() - mathStart);
            const cost = numPages * 0.005;
            await context.costTracker.record('parsing', 'mathpix', 'mathpix', 0, 0, cost, durationMs);
            parsed = mathpixParsed;
            context.logger.info(`Mathpix re-parse: ${parsed.sections.length} sections, ${numPages} pages, $${cost.toFixed(3)}`);
          } catch (err) {
            context.logger.warn(`Mathpix fallback failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // Guard 2: text size
    const totalChars = countTextChars(parsed.sections);
    if (totalChars > GUARD_MAX_TEXT_CHARS) {
      throw new Error(`text_exceeded: ${totalChars} chars (limit ${GUARD_MAX_TEXT_CHARS})`);
    }

    return parsed;
  }
}

// ─── Markdown Strategy (Portal direct .md submissions) ────

export class MarkdownStrategy implements ParseStrategy {
  name = 'markdown';

  async parse(document: Document, context: PipelineContext): Promise<ParsedDocument> {
    const mdPath = document.sources?.markdown?.path;
    if (!mdPath) {
      throw new Error('No markdown source path');
    }

    const parsed = await parseMarkdownFile(mdPath);

    // Guard: text size check (mirror LaTeX limit; markdown is similarly LLM-bounded)
    const totalChars = countTextChars(parsed.sections);
    if (totalChars > GUARD_MAX_TEXT_CHARS) {
      throw new Error(`text_exceeded: Markdown text ${totalChars} chars (limit ${GUARD_MAX_TEXT_CHARS})`);
    }

    context.logger.info(`Markdown parse complete: ${parsed.sections.length} sections, ${parsed.references.length} refs, ${parsed.formulas.length} formulas`);
    return parsed;
  }
}

// ─── Strategy selector ─────────────────────────────────────

export function selectStrategy(document: Document, parserStep: ParserStep): ParseStrategy {
  if (document.sourceFormat === 'markdown' && document.sources?.markdown?.path) {
    return new MarkdownStrategy();
  }
  if (document.sourceFormat === 'latex' && document.sources?.latex?.path) {
    return new LatexStrategy();
  }
  return new PdfStrategy(parserStep);
}

/**
 * Parse with strategy selection and automatic fallback.
 * If LaTeX strategy fails, falls back to PDF strategy.
 */
/** Minimum total section+abstract characters below which LaTeX output is
 *  considered structurally empty. ICML/submission archives sometimes put
 *  the real body in supplement.tex that isn't \input'd from the detected
 *  root (openarx-f2ew). A numerically valid but content-empty parse
 *  looks identical to a working parse upstream of the chunker — we catch
 *  it here and give PDF one more shot. */
const LATEX_MIN_BODY_CHARS = 500;

export async function parseWithStrategy(
  document: Document,
  context: PipelineContext,
  parserStep: ParserStep,
): Promise<ParsedDocument> {
  const primary = selectStrategy(document, parserStep);

  if (primary.name === 'latex') {
    let latexParsed: ParsedDocument | null = null;
    try {
      latexParsed = await primary.parse(document, context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.logger.warn(`LaTeX strategy failed, falling back to PDF: ${msg}`);
      const fallback = new PdfStrategy(parserStep);
      return fallback.parse(document, context);
    }

    // Content-empty check: even on a successful parse, LaTeX can produce
    // `sections=[{"name":"Code","content":""},{"name":"Figures","content":""}]`
    // when the body lives in an un-included supplement file. Downstream
    // the chunker returns []; the old path then silently finalised as
    // ready with zero chunks. If we have a PDF, give it a shot.
    const bodyChars = countTextChars(latexParsed.sections) + (latexParsed.abstract?.length ?? 0);
    if (bodyChars < LATEX_MIN_BODY_CHARS && document.rawContentPath) {
      try {
        const hasPdf = (await stat(document.rawContentPath)).size > 0;
        if (hasPdf) {
          context.logger.warn(
            `LaTeX parse produced ${bodyChars} body chars (< ${LATEX_MIN_BODY_CHARS}), trying PDF fallback`,
          );
          const fallback = new PdfStrategy(parserStep);
          const pdfParsed = await fallback.parse(document, context);
          const pdfChars = countTextChars(pdfParsed.sections) + (pdfParsed.abstract?.length ?? 0);
          // Only accept PDF result if it's actually better. Otherwise keep
          // the LaTeX result so downstream zero-chunk invariant (F1) still
          // marks the doc failed rather than masking with another empty
          // parse.
          if (pdfChars > bodyChars) {
            context.logger.info(`PDF fallback improved body: ${bodyChars} → ${pdfChars} chars`);
            return pdfParsed;
          }
          context.logger.warn(`PDF fallback no better (${pdfChars} chars), keeping LaTeX result`);
        }
      } catch (err) {
        context.logger.warn(
          `PDF fallback after empty LaTeX failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return latexParsed;
  }

  return primary.parse(document, context);
}

// ─── Helpers ───────────────────────────────────────────────

function countTextChars(sections: ParsedSection[]): number {
  let total = 0;
  function visit(secs: ParsedSection[]): void {
    for (const s of secs) {
      total += s.content.length;
      if (s.subsections) visit(s.subsections);
    }
  }
  visit(sections);
  return total;
}

const MATH_RE =
  /[\u2200-\u22FF\u0391-\u03C9\u00B2\u00B3\u00B9\u2070-\u209F]|\\(?:frac|sum|int|alpha|beta|gamma|delta|theta|lambda|sigma|omega|infty|partial|nabla|sqrt|prod|lim)\b/;

function estimateMathDensity(sections: ParsedSection[]): number {
  let total = 0;
  let withMath = 0;
  function visit(secs: ParsedSection[]): void {
    for (const s of secs) {
      if (s.content.trim()) { total++; if (MATH_RE.test(s.content)) withMath++; }
      if (s.subsections) visit(s.subsections);
    }
  }
  visit(sections);
  return total > 0 ? withMath / total : 0;
}

async function countPdfPages(pdfPath: string): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(pdfPath);
  const text = buf.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?!s)/g);
  return matches?.length ?? 0;
}
