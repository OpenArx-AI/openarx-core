/**
 * LaTeX source parser — converts extracted .tex source to ParsedDocument.
 *
 * Pipeline: findRootTex → resolveInputs → stripPreamble → extractSections
 *           + extractBibEntries → ParsedDocument
 *
 * No external dependencies — pure TypeScript + regex.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import type { ParsedDocument, ParsedSection, ParsedReference, ParsedFormula } from '@openarx/types';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('latex-parser');

// ─── Main entry point ──────────────────────────────────────

export async function parseLatexSource(
  sourceDir: string,
  rootTexFile?: string,
): Promise<ParsedDocument> {
  const start = performance.now();

  // Find root .tex
  const rootTex = rootTexFile ?? await findRootTex(sourceDir);
  if (!rootTex) {
    throw new Error('No root .tex file found (no 00README.json manifest and no \\documentclass)');
  }

  const rootPath = join(sourceDir, rootTex);
  log.info({ sourceDir, rootTex }, 'Parsing LaTeX source');

  // Resolve \input{} / \include{} / \subfile{} recursively
  const missingIncludes: string[] = [];
  const mergedTex = await resolveInputs(rootPath, dirname(rootPath), 0, sourceDir, missingIncludes);

  // Strip preamble (everything before \begin{document})
  const bodyTex = stripPreamble(mergedTex);

  // Strip LaTeX commands but keep content, sections, math, citations
  const cleanedTex = stripCommands(bodyTex);

  // Extract sections from cleaned text
  const { title, abstract, sections: rawSections } = extractSections(cleanedTex);

  // Filter bibliography sections from chunking (they add noise to embeddings)
  const { sections, removedBibSections } = filterBibliographySections(rawSections);

  // Extract formulas
  const formulas = extractFormulas(bodyTex);

  // Extract bibliography entries from .bib files + inline thebibliography
  const references = await extractBibEntries(sourceDir);
  // Also parse inline \bibitem entries that were filtered from sections
  if (removedBibSections > 0) {
    log.debug({ removedBibSections }, 'Filtered bibliography sections from chunking');
  }

  // Extract URLs
  const urls = extractUrls(bodyTex);

  const parseDurationMs = Math.round(performance.now() - start);

  log.info({
    rootTex,
    sections: sections.length,
    formulas: formulas.length,
    references: references.length,
    urls: urls.length,
    chars: cleanedTex.length,
    parseDurationMs,
  }, 'LaTeX parse complete');

  return {
    title,
    abstract,
    sections,
    references,
    tables: [],
    formulas,
    parserUsed: 'latex',
    parseDurationMs,
    stats: {
      missingIncludes,
      mergedTexChars: mergedTex.length,
      rootTex,
    },
  };
}

// ─── Find root .tex ────────────────────────────────────────

// Filename patterns that indicate auxiliary files, not the paper body.
// These lose score during root detection (not hard-skipped, so single-file
// archives still work).
const AUX_NAME_PATTERNS: RegExp[] = [
  /template/i,
  /rebuttal/i,
  /response/i,
  /reply/i,
  /reviewer/i,
  /sample/i,
  /example/i,
  /testflow/i,
  /commitment/i,
  /statement/i,
  /checklist/i,
  /_filled\b/i,
  /responsible.*research/i,
  /reproducib/i,
  /\bsupp_/i,
  /supplement/i,
  // Fragment-style names: partial documents, not the whole submission.
  // Catches mppi_appendices, begin, manus, etc. that lose to main.tex
  // on scoring but win when no main.tex exists.
  /^begin$/i, /^end$/i, /^preamble$/i,
  /appendi(?:x|ces)$/i,
  /^intro(?:duction)?$/i,
  /^manus(?:cript)?$/i,
  /submission/i,
];

// Directory patterns that indicate vendored packages or auxiliary material.
// Files inside these dirs lose score.
const AUX_DIR_PATTERNS: RegExp[] = [
  /^(?:ieeetran|ieee|acl|acm|neurips|icml|iclr|cvf|ijcai|aaai|springer|elsevier)$/i,
  /^(?:style|template|cls|pkg|format|sty)$/i,
  /^(?:fig|figs|figures|image|images|plot|plots|graphics|pics)$/i,
  /^(?:bib|biblio|references)$/i,
  /^(?:rebuttal|response|reply|review)$/i,
  /^(?:supp|supplement|appendix|appendices)$/i,
];

const CANONICAL_ROOT_NAMES = new Set([
  'main', 'paper', 'manuscript', 'article', 'ms', 'arxiv', 'root', 'body',
  'long', 'full', 'camera-ready', 'cameraready',
]);

/**
 * Score a single .tex candidate for "is this the paper root?".
 * Higher = better. Negative = disqualifying.
 */
async function scoreRootCandidate(sourceDir: string, file: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(join(sourceDir, file), 'utf-8');
  } catch {
    return Number.NEGATIVE_INFINITY;
  }

  // Normally we require \begin{document}. Exception: paper-split archives
  // where the body/body-wrapper is in a separate file included via \input.
  // E.g. 2102.10749 has arxiv.tex (the real root with \documentclass +
  // \section structure) that does `\input{begin.tex}` and begin.tex owns
  // the \begin{document}. Accept the candidate if it has \documentclass
  // plus substantial structure signal (\section or length) AND inputs
  // another tex file — that's the paper-split signature.
  const hasBeginDoc = /\\begin\{document\}/.test(content);
  const hasDocumentclass = /\\documentclass/.test(content);
  const hasSections = /\\section\s*\*?\s*\{/.test(content);
  const hasInputs = /\\(?:input|include|subfile|import)\b/.test(content);
  const isPaperSplit = !hasBeginDoc && hasDocumentclass && hasInputs && (hasSections || content.length > 3000);

  if (!hasBeginDoc && !isPaperSplit) return Number.NEGATIVE_INFINITY;

  // Start: full credit if real \begin{document}, partial if paper-split.
  let score = hasBeginDoc ? 10 : 5;
  const baseName = basename(file, '.tex').toLowerCase();
  const topDir = file.includes('/') ? file.split('/', 1)[0].toLowerCase() : '';

  if (CANONICAL_ROOT_NAMES.has(baseName)) score += 30;
  if (AUX_NAME_PATTERNS.some((re) => re.test(baseName))) score -= 20;
  if (!file.includes('/')) score += 15; // root-level preferred over nested
  if (topDir && AUX_DIR_PATTERNS.some((re) => re.test(topDir))) score -= 30;
  // Depth penalty: a root 3 dirs deep (`foo/bar/baz/main.tex`) is almost
  // certainly an internal note / supplementary draft, not the submission.
  // Catches `AAMAS-*/notes/embedding_space.tex`-style picks.
  const depth = file.split('/').length - 1;
  if (depth >= 2) score -= (depth - 1) * 15;
  // `notes/` or `draft/` path segment anywhere → not the submission.
  if (/\/(?:notes?|drafts?|scratch|tmp|tempo|old|archive)\//i.test('/' + file + '/')) score -= 25;

  // Master files include body parts — count \input / \include / \subfile /
  // \import. Standalone figure/template files usually have 0.
  const includes = content.match(/\\(?:input|include|subfile|import|subimport)\b/g);
  score += Math.min((includes?.length ?? 0) * 2, 20);

  if (content.length > 10000) score += 10;
  else if (content.length > 2000) score += 5;
  else if (content.length > 500) score += 2;

  return score;
}

// Re-exported for test harness. Single source of truth to prevent drift
// (earlier iteration had divergent filter lists in parser vs test-script).
export { isBodyInclude, unescapeLatexPath } from './include-filter.js';
import { isBodyInclude, unescapeLatexPath } from './include-filter.js';

/** Probe a root candidate: read it, pull out body-\input paths, check how
 *  many resolve to existing files on disk. Returns resolution ratio (0..1)
 *  and raw counts. Cheap: one readFile + N stat calls via access(). */
const PROBE_INPUT_RE = /\\(?:input|include|subfile)\s*\{([^}]+)\}|\\input\s+([^\s%{\\][\w./-]*)|\\(?:import|subimport)\s*\{([^}]*)\}\s*\{([^}]+)\}/g;
async function probeRootResolution(
  sourceDir: string,
  rootFile: string,
): Promise<{ total: number; resolved: number; ratio: number }> {
  let text: string;
  try {
    text = await readFile(join(sourceDir, rootFile), 'utf-8');
  } catch {
    return { total: 0, resolved: 0, ratio: 0 };
  }
  const baseDir = dirname(join(sourceDir, rootFile));
  let total = 0;
  let resolved = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(PROBE_INPUT_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    let incPath: string | null = null;
    if (m[1] !== undefined) incPath = m[1];
    else if (m[2] !== undefined) incPath = m[2];
    else if (m[3] !== undefined && m[4] !== undefined) incPath = join(m[3], m[4]);
    if (!incPath) continue;
    incPath = unescapeLatexPath(incPath);
    if (!isBodyInclude(incPath)) continue;
    total++;

    const variants = [
      join(baseDir, incPath),
      join(baseDir, incPath) + '.tex',
      join(baseDir, incPath.replace(/\s+/g, '_')),
      join(baseDir, incPath.replace(/\s+/g, '_')) + '.tex',
      join(sourceDir, incPath),
      join(sourceDir, incPath) + '.tex',
    ];
    let found = false;
    for (const v of variants) {
      try { await access(v); found = true; break; } catch { /* next */ }
    }
    if (found) resolved++;
  }
  return { total, resolved, ratio: total === 0 ? 1 : resolved / total };
}

export async function findRootTex(sourceDir: string): Promise<string | null> {
  // Tier 1: 00README.json manifest (89% of arXiv archives have it)
  try {
    const manifest = JSON.parse(await readFile(join(sourceDir, '00README.json'), 'utf-8'));
    const toplevel = manifest.sources?.find(
      (s: { usage: string; filename: string }) => s.usage === 'toplevel',
    );
    if (toplevel?.filename) return toplevel.filename;
  } catch {
    // No manifest — use scoring
  }

  const files = await findTexFiles(sourceDir);

  // Tier 2: score every .tex candidate.
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const score = await scoreRootCandidate(sourceDir, file);
    if (score === Number.NEGATIVE_INFINITY) continue;
    scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 1) return scored[0].file;

  if (scored.length >= 2) {
    // Tier 2b: top-1 is the common case. Only re-evaluate if the runner-up
    // is within 20 points — that's the "multiple viable candidates" signal
    // (e.g. archive has `iclr_2023/main.tex` + `neurips_2022/main.tex`).
    const top = scored[0];
    const runnerUp = scored[1];
    if (top.score - runnerUp.score >= 20) return top.file;

    // Probe up to top-3 for \input resolution. Pick the one with the best
    // combined structural + resolution score.
    const topN = Math.min(3, scored.length);
    let bestCombined: { file: string; combined: number } | null = null;
    for (let i = 0; i < topN; i++) {
      const probe = await probeRootResolution(sourceDir, scored[i].file);
      // Only apply resolution bonus when the file actually has includes to
      // resolve — standalone papers without \input shouldn't get +40 free.
      const resolutionBonus = probe.total === 0 ? 0 : probe.ratio * 40;
      const combined = scored[i].score + resolutionBonus;
      if (bestCombined === null || combined > bestCombined.combined) {
        bestCombined = { file: scored[i].file, combined };
      }
    }
    if (bestCombined) return bestCombined.file;
    return scored[0].file;
  }

  // Tier 3 (legacy fallback): first .tex with \documentclass. Preserves
  // behaviour for archives where no file has \begin{document} (rare).
  for (const file of files) {
    const content = await readFile(join(sourceDir, file), 'utf-8');
    if (/\\documentclass/.test(content)) return file;
  }

  return null;
}

async function findTexFiles(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...await findTexFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.tex')) {
      result.push(rel);
    }
  }
  return result;
}

// ─── Resolve \input{} / \include{} ────────────────────────

/**
 * Try variants of a path when the literal path doesn't exist. Handles
 * authors who wrote `\input{01 introduction}` but named the file
 * `01_introduction.tex` (spaces→underscore), plus the usual `.tex` suffix
 * and space-removal fallbacks.
 */
async function tryReadWithVariants(filePath: string): Promise<string | null> {
  const candidates = [
    filePath,
    filePath + '.tex',
    filePath.replace(/\s+/g, '_'),
    filePath.replace(/\s+/g, '_') + '.tex',
    filePath.replace(/\s+/g, ''),
    filePath.replace(/\s+/g, '') + '.tex',
  ];
  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand)) continue;
    seen.add(cand);
    try {
      return await readFile(cand, 'utf-8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Replace LaTeX comment regions with same-length whitespace, preserving
 * byte offsets. Used to neutralise commented-out `\input{}` etc. before
 * regex matching — without this, Inkscape figure files (which embed
 * `%   \input{<filename>.pdf_tex}` as a usage-hint header) inflate the
 * missing-includes count by dozens per figure.
 *
 * Honours `\%` as escaped percent. Comments run from `%` to end-of-line.
 */
export function maskLatexComments(text: string): string {
  return text.replace(/(?<!\\)%[^\n]*/g, (m) => ' '.repeat(m.length));
}

async function resolveInputs(
  filePath: string,
  baseDir: string,
  depth = 0,
  sourceRoot?: string,
  missingOut?: string[],
): Promise<string> {
  if (depth > 10) return `% [MAX_DEPTH exceeded: ${filePath}]\n`;

  const text = await tryReadWithVariants(filePath);
  if (text === null) {
    missingOut?.push(filePath);
    return `% [MISSING: ${filePath}]\n`;
  }

  // Mask comments so commented-out `\input{}` lines are not matched as real
  // includes. Same-length whitespace preserves offsets so regex match
  // indices stay valid for slicing the original `text` for output.
  const scanText = maskLatexComments(text);

  // Replace include macros with file contents. Supported forms:
  //   \input{name} / \include{name} / \subfile{name}     — group 1
  //   \input name (no braces, space-terminated)          — group 2
  //   \import{dir}{file} / \subimport{dir}{file}         — groups 3 + 4 (dir + file)
  const inputRe = /\\(?:input|include|subfile)\s*\{([^}]+)\}|\\input\s+([^\s%{\\][\w./-]*)|\\(?:import|subimport)\s*\{([^}]*)\}\s*\{([^}]+)\}/g;
  const parts: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = inputRe.exec(scanText)) !== null) {
    parts.push(text.slice(lastIdx, match.index));

    // Determine include path from whichever alternative matched
    let includePath: string;
    if (match[1] !== undefined) {
      includePath = match[1];
    } else if (match[2] !== undefined) {
      includePath = match[2];
    } else if (match[3] !== undefined && match[4] !== undefined) {
      includePath = join(match[3], match[4]);
    } else {
      includePath = '';
    }
    // LaTeX-escape unescape: `\_` → `_`, etc. Authors write
    // \input{section\_1} but the filesystem has `section_1.tex`.
    includePath = unescapeLatexPath(includePath);
    // Skip paths with unexpanded macros like \input{\filenamebase.title}
    // — they'd need a full LaTeX evaluator to resolve. Don't record as
    // missing either, since it's a parser limitation, not a content loss
    // we can fix.
    if (includePath.includes('\\')) {
      parts.push(`% [MACRO_INPUT: ${includePath}]\n`);
      lastIdx = match.index + match[0].length;
      continue;
    }

    // Try resolving from baseDir first, then from sourceRoot as fallback
    // (handles cases where \input{latex/foo} is relative to project root, not .tex file)
    let refPath = join(baseDir, includePath);
    // Probe baseDir first without recording missing; only record after the
    // sourceRoot fallback also fails, otherwise we'd double-report paths
    // that simply lived at project root.
    const probe: string[] = [];
    let resolved = await resolveInputs(refPath, dirname(refPath), depth + 1, sourceRoot, probe);
    if (resolved.startsWith('% [MISSING:') && sourceRoot && sourceRoot !== baseDir) {
      refPath = join(sourceRoot, includePath);
      const fallbackProbe: string[] = [];
      resolved = await resolveInputs(refPath, dirname(refPath), depth + 1, sourceRoot, fallbackProbe);
      if (resolved.startsWith('% [MISSING:')) {
        missingOut?.push(includePath);
      } else {
        // Fallback succeeded — propagate nested misses from the successful branch
        missingOut?.push(...fallbackProbe);
      }
    } else {
      // baseDir succeeded (or no sourceRoot fallback available) — propagate
      missingOut?.push(...probe);
    }
    parts.push(resolved);
    lastIdx = match.index + match[0].length;
  }
  parts.push(text.slice(lastIdx));

  return parts.join('');
}

// ─── Strip preamble ────────────────────────────────────────

function stripPreamble(tex: string): string {
  // Strip LaTeX comments first. Otherwise `%\begin{document}` in the
  // preamble (common pattern: authors show two alternate document
  // shells and comment one out) would be found by indexOf and we'd cut
  // the preamble at the wrong place, skipping the entire real body.
  // A comment starts at an unescaped % and runs to end of line.
  const decommented = tex.replace(/(^|[^\\])%[^\n]*/g, '$1');
  const beginDoc = decommented.indexOf('\\begin{document}');
  if (beginDoc === -1) return decommented.trim();
  let body = decommented.slice(beginDoc + '\\begin{document}'.length);
  const endDoc = body.indexOf('\\end{document}');
  if (endDoc !== -1) body = body.slice(0, endDoc);
  return body.trim();
}

// ─── Strip commands (keep content, sections, math, citations) ──

export function stripCommands(tex: string): string {
  let t = tex;

  // Remove \maketitle, \thispagestyle, \pagestyle, \setcounter, etc.
  t = t.replace(/\\(?:maketitle|thispagestyle|pagestyle|setcounter|addtocounter)\{[^}]*\}/g, '');

  // Remove \newcommand, \renewcommand, \def definitions
  t = t.replace(/\\(?:newcommand|renewcommand)\*?\{[^}]*\}(?:\[[^\]]*\])*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, '');

  // Remove LaTeX comments (lines starting with %)
  t = t.replace(/^%.*$/gm, '');
  t = t.replace(/(?<!\\)%.*$/gm, '');

  // Unwrap \verb|...|  and \verb+...+ (any delimiter)
  t = t.replace(/\\verb(.)(.*?)\1/g, '$2');

  // Unwrap formatting commands: \textbf{X} → X, \emph{X} → X
  t = t.replace(/\\(?:textbf|textit|emph|underline|textsc|textrm|texttt|mbox)\{([^}]*)\}/g, '$1');

  // Unwrap \footnote{...} → (content)
  t = t.replace(/\\footnote\{((?:[^{}]|\{[^{}]*\})*)\}/g, ' ($1)');

  // Unwrap \blockquote{...} → content
  t = t.replace(/\\blockquote\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1');

  // Remove \begin{algorithm}...\end{algorithm} (pseudocode, not prose)
  t = t.replace(/\\begin\{algorithm\}.*?\\end\{algorithm\}/gs, '[Algorithm]');

  // Remove pure layout commands
  t = t.replace(/\\(?:centering|raggedright|raggedleft|noindent|smallskip|medskip|bigskip|newpage|clearpage|pagebreak|vfill|hfill)\b/g, '');
  t = t.replace(/\\(?:vspace|hspace)\*?\{[^}]*\}/g, '');

  // Remove \label{...}, \Cref{...}, \cref{...}, \ref{...}
  t = t.replace(/\\label\{[^}]*\}/g, '');
  t = t.replace(/\\[Cc]ref\{[^}]*\}/g, '');
  t = t.replace(/\\ref\{[^}]*\}/g, '');

  // Remove figure environments but keep captions
  t = t.replace(/\\begin\{figure\*?\}.*?\\end\{figure\*?\}/gs, (m) => {
    const caption = m.match(/\\caption\{([^}]*)\}/);
    return caption ? `[Figure: ${caption[1]}]` : '';
  });

  // Remove table environments but keep captions
  t = t.replace(/\\begin\{table\*?\}.*?\\end\{table\*?\}/gs, (m) => {
    const caption = m.match(/\\caption\{([^}]*)\}/);
    return caption ? `[Table: ${caption[1]}]` : '';
  });

  // Remove includegraphics
  t = t.replace(/\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/g, '');

  // Remove \begin{minipage}...\end{minipage}, \begin{wrapfigure}...\end{wrapfigure}
  t = t.replace(/\\begin\{(?:minipage|wrapfigure)\}.*?\\end\{(?:minipage|wrapfigure)\}/gs, '');

  // Keep \cite{...} as is (valuable for enrichment)
  // Keep $...$ and \[...\] as is (math)
  // Keep \section{...}, \subsection{...} etc. (structure)
  // Keep \url{...}, \href{...} (links)

  // Clean up excessive whitespace
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

// ─── Extract sections ──────────────────────────────────────

function extractSections(tex: string): { title: string; abstract: string; sections: ParsedSection[] } {
  let title = '';
  let abstract = '';

  // Extract \title{...}
  const titleMatch = tex.match(/\\title\{([^}]*)\}/);
  if (titleMatch) title = titleMatch[1].replace(/\s+/g, ' ').trim();

  // Extract abstract
  const absMatch = tex.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
  if (absMatch) abstract = absMatch[1].trim();

  // Split on \section, \subsection, \subsubsection
  const sectionRe = /\\((?:sub)*section)\*?\{([^}]*)\}/g;
  const sections: ParsedSection[] = [];
  const matches: Array<{ level: number; name: string; matchIdx: number; startIdx: number }> = [];

  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(tex)) !== null) {
    const cmd = m[1];
    const level = cmd === 'section' ? 1 : cmd === 'subsection' ? 2 : 3;
    matches.push({ level, name: m[2].trim(), matchIdx: m.index, startIdx: m.index + m[0].length });
  }

  // Build hierarchical structure using a stack
  const stack: ParsedSection[] = []; // tracks current nesting: [section, subsection, ...]

  for (let i = 0; i < matches.length; i++) {
    // Content spans from after this header to the start of the next header (or end of text)
    const endIdx = i + 1 < matches.length ? matches[i + 1].matchIdx : tex.length;
    const content = tex.slice(matches[i].startIdx, endIdx).trim();

    const node: ParsedSection = {
      name: matches[i].name,
      content,
      level: matches[i].level,
    };

    // Pop stack until we find a parent with lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (stack.length > 0) {
      // Nest under parent
      const parent = stack[stack.length - 1];
      if (!parent.subsections) parent.subsections = [];
      parent.subsections.push(node);
    } else {
      // Top-level section
      sections.push(node);
    }

    stack.push(node);
  }

  // If no sections found, treat entire text as one section
  if (sections.length === 0 && tex.trim().length > 0) {
    sections.push({ name: 'Content', content: tex.trim(), level: 1 });
  }

  return { title, abstract, sections };
}

// ─── Filter bibliography sections ─────────────────────────

const BIB_SECTION_RE = /^(references|bibliography|bibliograph)$/i;
const BIB_CONTENT_RE = /\\bibitem/;

/**
 * Remove sections that are bibliography / reference lists.
 * These add noise to embeddings (citation metadata, not paper content).
 * Detected by section name ("References") or content (\bibitem entries).
 */
function filterBibliographySections(
  sections: ParsedSection[],
): { sections: ParsedSection[]; removedBibSections: number } {
  let removed = 0;

  function filterRecursive(secs: ParsedSection[]): ParsedSection[] {
    const result: ParsedSection[] = [];
    for (const s of secs) {
      const isBibByName = BIB_SECTION_RE.test(s.name);
      const isBibByContent = BIB_CONTENT_RE.test(s.content);

      if (isBibByName || isBibByContent) {
        removed++;
        continue;
      }

      const filtered = { ...s };
      if (filtered.subsections?.length) {
        filtered.subsections = filterRecursive(filtered.subsections);
      }
      result.push(filtered);
    }
    return result;
  }

  const filtered = filterRecursive(sections);
  return { sections: filtered, removedBibSections: removed };
}

// ─── Extract formulas ──────────────────────────────────────

function extractFormulas(tex: string): ParsedFormula[] {
  const formulas: ParsedFormula[] = [];

  // Display math: \[...\], $$...$$, \begin{equation}...\end{equation}, \begin{align}...\end{align}
  const displayRe = /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\begin\{(?:equation|align|gather|multline)\*?\}([\s\S]*?)\\end\{(?:equation|align|gather|multline)\*?\}/g;
  let m: RegExpExecArray | null;

  while ((m = displayRe.exec(tex)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    const labelMatch = raw.match(/\\label\{([^}]*)\}/);
    formulas.push({ raw, label: labelMatch?.[1] });
  }

  return formulas;
}

// ─── Extract bibliography ──────────────────────────────────

const MAX_REFS = 1000; // Cap: no paper needs more than 1000 refs in our pipeline

async function extractBibEntries(sourceDir: string): Promise<ParsedReference[]> {
  const refs: ParsedReference[] = [];

  // Find .bib files
  const files = await findFilesWithExt(sourceDir, '.bib');
  for (const bibFile of files) {
    try {
      const content = await readFile(join(sourceDir, bibFile), 'utf-8');
      const entryRe = /@\w+\{([^,]*),([\s\S]*?)(?=\n@|\n*$)/g;
      let m: RegExpExecArray | null;

      while ((m = entryRe.exec(content)) !== null) {
        if (refs.length >= MAX_REFS) {
          log.warn({ bibFile, refsFound: refs.length }, 'Bib file exceeds ref cap, truncating');
          break;
        }
        const key = m[1].trim();
        const body = m[2];

        const getField = (name: string): string | undefined => {
          const fieldRe = new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`, 'i');
          return body.match(fieldRe)?.[1]?.trim();
        };

        refs.push({
          raw: `${key}: ${getField('title') ?? ''} (${getField('year') ?? ''})`,
          title: getField('title'),
          authors: getField('author')?.split(' and ').map((a) => a.trim()),
          year: getField('year'),
          venue: getField('journal') ?? getField('booktitle'),
          doi: getField('doi'),
          url: getField('url'),
        });
      }
    } catch {
      log.warn({ bibFile }, 'Failed to parse .bib file');
    }
  }

  // Also try .bbl files if no .bib entries found
  if (refs.length === 0) {
    const bblFiles = await findFilesWithExt(sourceDir, '.bbl');
    for (const bblFile of bblFiles) {
      try {
        const content = await readFile(join(sourceDir, bblFile), 'utf-8');
        const bibitemRe = /\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}\s*([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\}|$)/g;
        let m: RegExpExecArray | null;

        while ((m = bibitemRe.exec(content)) !== null) {
          if (refs.length >= MAX_REFS) break;
          refs.push({ raw: m[2].replace(/\s+/g, ' ').trim() });
        }
      } catch {
        log.warn({ bblFile }, 'Failed to parse .bbl file');
      }
    }
  }

  return refs;
}

async function findFilesWithExt(dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(ext)) {
        result.push(entry.name);
      }
    }
  } catch {
    // directory not readable
  }
  return result;
}

// ─── Extract URLs ──────────────────────────────────────────

function extractUrls(tex: string): string[] {
  const urls: string[] = [];
  const urlRe = /\\(?:url|href)\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(tex)) !== null) {
    urls.push(m[1]);
  }
  return [...new Set(urls)];
}
