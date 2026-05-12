/**
 * Markdown parser — Markdown text → ParsedDocument.
 *
 * Two callers share this code:
 *   1. mathpix-parser.ts — receives Mathpix-converted markdown for an
 *      uploaded PDF (cost $0.005/page).
 *   2. parse-strategy.ts MarkdownStrategy — direct .md submissions
 *      from Portal (free).
 *
 * The regex-based heading detection works for both shapes because
 * Mathpix output and well-formed scientific Markdown share the same
 * '# Heading' / '## Numbered.Section' conventions.
 */

import { readFile } from 'node:fs/promises';
import type { ParsedDocument, ParsedSection, ParsedFormula, ParsedReference } from '@openarx/types';

interface FlatHeading {
  level: number; // 1 = #, 2 = ##, 3 = ###, 4 = ####
  title: string;
  content: string;
  numbering: string | undefined; // "3", "3.1", "3.2.1"
  depth: number; // from numbering
}

const HEADING_RE = /^(#{1,4})\s+(.+)$/;
const NUMBERED_HEADING_RE = /^([A-Z]?\d+(?:\.\s?\d+)*)\s+(.+)$/;
const FORMULA_BLOCK_RE = /\$\$([\s\S]*?)\$\$/g;
const FORMULA_LABEL_RE = /\((\d+[a-z]?)\)\s*$/;

export interface ParseMarkdownOptions {
  /** Source label written into ParsedDocument.parserUsed.
   *  'mathpix' when called from the OCR fallback pipeline,
   *  'markdown' when parsing a direct .md submission. */
  parserUsed?: string;
  /** Forwarded into ParsedDocument.parseDurationMs (caller-measured). */
  parseDurationMs?: number;
}

/** Parse a Markdown string into the canonical ParsedDocument shape. */
export function parseMarkdown(
  markdown: string,
  opts: ParseMarkdownOptions = {},
): ParsedDocument {
  const lines = markdown.split('\n');
  const headings: FlatHeading[] = [];
  let title = '';
  let abstract = '';

  let currentHeading: FlatHeading | null = null;
  let inAbstract = false;
  let abstractLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);

    if (headingMatch) {
      // Save previous heading
      if (currentHeading) {
        currentHeading.content = currentHeading.content.trim();
        headings.push(currentHeading);
      }

      const level = headingMatch[1].length;
      let headingText = headingMatch[2].trim();

      // Clean HTML tags from heading
      headingText = headingText.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').trim();

      // Extract title from first # heading
      if (level === 1 && !title) {
        title = headingText;
        currentHeading = null;
        inAbstract = false;
        continue;
      }

      // Detect abstract
      if (headingText.toLowerCase().startsWith('abstract')) {
        inAbstract = true;
        abstractLines = [];
        currentHeading = null;
        continue;
      }

      // End abstract on next heading
      if (inAbstract) {
        abstract = abstractLines.join('\n').trim();
        inAbstract = false;
      }

      // Extract numbering from heading text (e.g. "3.2.1 Some Title")
      const numMatch = headingText.match(NUMBERED_HEADING_RE);
      let numbering: string | undefined;
      let sectionName: string;

      if (numMatch) {
        numbering = numMatch[1].replace(/\s/g, '');
        sectionName = numMatch[2].trim();
      } else {
        sectionName = headingText;
      }

      // Compute depth from numbering or heading level
      const depth = numbering ? numbering.split('.').length : level - 1;

      currentHeading = { level, title: sectionName, content: '', numbering, depth };
    } else if (inAbstract) {
      abstractLines.push(line);
    } else if (currentHeading) {
      currentHeading.content += line + '\n';
    }
  }

  // Save last heading
  if (currentHeading) {
    currentHeading.content = currentHeading.content.trim();
    headings.push(currentHeading);
  }

  // Finalize abstract if it was the last section
  if (inAbstract && abstractLines.length > 0) {
    abstract = abstractLines.join('\n').trim();
  }

  const sections = buildHierarchy(headings);
  const formulas = extractFormulas(markdown);
  const references = extractReferences(headings);

  return {
    title,
    abstract,
    sections,
    references,
    tables: [],
    formulas,
    parserUsed: opts.parserUsed ?? 'markdown',
    parseDurationMs: opts.parseDurationMs ?? 0,
  };
}

/** Read a .md file from disk and parse it. Used by MarkdownStrategy
 *  in parse-strategy.ts for Portal-submitted markdown content. */
export async function parseMarkdownFile(path: string): Promise<ParsedDocument> {
  const start = performance.now();
  const text = await readFile(path, 'utf-8');
  const parseDurationMs = Math.round(performance.now() - start);
  return parseMarkdown(text, { parserUsed: 'markdown', parseDurationMs });
}

function buildHierarchy(headings: FlatHeading[]): ParsedSection[] {
  const root: ParsedSection[] = [];
  const stack: Array<{ section: ParsedSection; depth: number }> = [];

  for (const h of headings) {
    const section: ParsedSection = {
      name: h.title,
      content: h.content,
      level: h.depth || 1,
    };

    if (h.depth <= 1) {
      root.push(section);
      stack.length = 0;
      stack.push({ section, depth: h.depth || 1 });
    } else {
      // Find parent with lower depth
      while (stack.length > 0 && stack[stack.length - 1].depth >= h.depth) {
        stack.pop();
      }

      if (stack.length > 0) {
        const parent = stack[stack.length - 1].section;
        if (!parent.subsections) parent.subsections = [];
        parent.subsections.push(section);
      } else {
        root.push(section);
      }

      stack.push({ section, depth: h.depth });
    }
  }

  return root;
}

function extractFormulas(markdown: string): ParsedFormula[] {
  const formulas: ParsedFormula[] = [];
  let match: RegExpExecArray | null;

  while ((match = FORMULA_BLOCK_RE.exec(markdown)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;

    const labelMatch = raw.match(FORMULA_LABEL_RE);
    formulas.push({
      raw,
      label: labelMatch?.[1],
    });
  }

  return formulas;
}

function extractReferences(headings: FlatHeading[]): ParsedReference[] {
  const refsSection = headings.find(
    (h) => h.title.toLowerCase() === 'references' || h.title.toLowerCase() === 'bibliography',
  );
  if (!refsSection) return [];

  // Simple line-based extraction: each reference is a paragraph
  const refs: ParsedReference[] = [];
  const lines = refsSection.content.split('\n\n');

  for (const line of lines) {
    const text = line.trim();
    if (text.length > 20) {
      refs.push({ raw: text });
    }
  }

  return refs;
}
