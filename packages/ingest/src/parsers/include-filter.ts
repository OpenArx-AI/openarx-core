/**
 * Shared include-path classification. Used by both the LaTeX parser
 * (findRootTex probe) and the parser-coverage test harness — single
 * source of truth so filters stay in sync.
 */

import { basename } from 'node:path';

/** Extensions that are never body prose. */
const NON_BODY_EXT = new Set([
  // LaTeX build artefacts
  'bbl', 'out', 'aux', 'toc', 'lof', 'lot', 'fls', 'fdb_latexmk', 'log',
  'nav', 'snm', 'vrb',
  // TikZ / PGF / plot data
  'pgf', 'tikz', 'tikzstyles', 'settings',
  // REVTeX / journal style metadata fragments
  'title', 'author', 'abs', 'pacs', 'body',
  // Graphics. Inkscape's pdf/svg-to-LaTeX export emits .pdf_tex shims that
  // are \input{}'d like prose but contain only positioning macros for an
  // accompanying raster/vector image. Authors also \input raw graphic
  // filenames in some templates. None of these are body content.
  'pdf_tex', 'pdf', 'svg', 'eps', 'ps', 'png', 'jpg', 'jpeg', 'gif',
]);

/** Basename patterns that indicate non-body asset files. */
const NON_BODY_NAME_RE: RegExp[] = [
  // Figures / plots / charts
  /^figure[-_]/i, /^fig[-_]\d/i, /^figs?\b/i,
  /^plot[-_]/i, /^chart[-_]/i, /^diagram/i,
  // Tables + table-shaped data filenames
  /^table[-_]/i, /^tab[-_]\d/i,
  /tabletest/i, /^test[-_]?table/i,
  // TikZ / PGF
  /^tikz/i, /^styles?tikz/i, /tikz(?:graph|fig|plot|style)/i,
  // Macro / preamble / header fragments
  /^macros?[-_]/i, /^preamble/i, /^header$/i, /^commands/i,
  // Explicit metadata file patterns
  /^author$/i, /^title$/i, /^abstract$/i, /^keywords$/i,
  // Generated / evaluation result fragments. Heuristic — matches names
  // like "performance_table_summary", "rank_cor_tab", "eval_results_N":
  // data-oriented filenames that aren't prose.
  /_summary$/i, /_results?$/i, /_cor(?:_|$)/i, /_range$/i,
  /evalres/i, /^results?_[a-z]/i,
];

/** Directory segments (anywhere in the path) that mark non-body assets. */
const NON_BODY_DIR_SEG = new Set([
  'figures', 'figure', 'figs', 'fig',
  'tables', 'table',
  'plots', 'plot',
  'graphics', 'graphic',
  'diagrams', 'diagram',
  'tikz', 'pgf',
  'images', 'image', 'img', 'imgs',
  'pics', 'pic',
]);

/** Decide whether a `\input` target is meant to contribute body prose.
 *  False for figure/table/macro/style files — their absence is NOT a
 *  content-loss signal.
 *
 *  Edge cases:
 *  - Path contains `\` (unexpanded LaTeX macro like `\filenamebase.title`):
 *    we can't resolve without a LaTeX engine, so we treat as non-body to
 *    keep the missing-includes signal meaningful.
 */
export function isBodyInclude(includePath: string): boolean {
  if (includePath.includes('\\')) return false;
  // Path-based: if any directory segment matches non-body set, skip.
  const segs = includePath.split('/').filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) {
    if (NON_BODY_DIR_SEG.has(segs[i].toLowerCase())) return false;
  }
  const base = basename(includePath).toLowerCase();
  const dotIdx = base.lastIndexOf('.');
  const ext = dotIdx >= 0 ? base.slice(dotIdx + 1) : '';
  if (ext && NON_BODY_EXT.has(ext)) return false;
  const nameOnly = ext ? base.slice(0, dotIdx) : base;
  if (NON_BODY_NAME_RE.some((re) => re.test(nameOnly))) return false;
  return true;
}

/** LaTeX allows `\_` inside arguments to represent a literal underscore
 *  (so `\input{section\_1}` targets file `section_1.tex`). We unescape
 *  before filesystem lookup. Also handle `\#`, `\&` for completeness. */
export function unescapeLatexPath(p: string): string {
  return p.replace(/\\([_#&])/g, '$1');
}
