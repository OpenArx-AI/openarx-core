/**
 * GROBID parser client.
 *
 * Sends PDF to GROBID's processFulltextDocument endpoint,
 * parses TEI XML response into ParsedDocument.
 */

import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import type {
  ParsedDocument,
  ParsedSection,
  ParsedReference,
  ParsedTable,
  ParsedFormula,
} from '@openarx/types';
import { retry, type RetryOptions } from '../lib/retry.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('grobid');

export interface GrobidClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retry?: RetryOptions;
}

const DEFAULTS = {
  baseUrl: 'http://localhost:8070',
  // 240s — covers large PDFs (up to ~30MB). Combined with retry()'s 3 attempts
  // this gives up to ~12 min worst case, but GROBID pool has 3 servers so
  // round-robin mitigates single-server slowness.
  timeoutMs: 240_000,
};

// Multi-server round-robin: GROBID_URLS=url1,url2,url3
const grobidServers: string[] = (() => {
  const urls = process.env.GROBID_URLS;
  if (urls) return urls.split(',').map((s) => s.trim()).filter(Boolean);
  const single = process.env.GROBID_URL;
  if (single) return [single];
  return [DEFAULTS.baseUrl];
})();
let grobidRoundRobin = 0;

function nextGrobidUrl(): string {
  const url = grobidServers[grobidRoundRobin % grobidServers.length];
  grobidRoundRobin++;
  return url;
}

if (grobidServers.length > 1) {
  log.info({ servers: grobidServers.length }, 'GROBID pool mode');
}

export async function checkGrobidHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/isalive`, { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function parseWithGrobid(
  pdfPath: string,
  opts?: Partial<GrobidClientOptions>,
): Promise<ParsedDocument> {
  const baseUrl = opts?.baseUrl ?? nextGrobidUrl();
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;

  const start = performance.now();

  const teiXml = await retry(
    async () => {
      const pdfBuffer = await readFile(pdfPath);
      const form = new FormData();
      form.append('input', new Blob([pdfBuffer], { type: 'application/pdf' }), 'paper.pdf');

      const resp = await fetch(`${baseUrl}/api/processFulltextDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`GROBID error ${resp.status}: ${body.slice(0, 200)}`);
      }

      return resp.text();
    },
    `grobid:${pdfPath}`,
    opts?.retry,
  );

  const parseDurationMs = Math.round(performance.now() - start);
  log.info({ pdfPath, parseDurationMs }, 'GROBID parse complete');

  return parseTeiXml(teiXml, parseDurationMs);
}

// ── TEI XML parsing ──

function parseTeiXml(xml: string, parseDurationMs: number): ParsedDocument {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    isArray: (tagName) =>
      ['div', 'p', 'author', 'biblStruct', 'row', 'cell', 'formula', 'figure'].includes(tagName),
    preserveOrder: false,
    trimValues: true,
  });

  const doc = parser.parse(xml);
  const tei = doc.TEI ?? doc;
  const header = tei.teiHeader ?? {};
  const text = tei.text ?? {};
  const body = text.body ?? {};
  const back = text.back ?? {};

  const title = extractTitle(header);
  const abstract = extractAbstract(header);
  const sections = extractSections(body);
  const references = extractReferences(back);
  const tables = extractTables(body);
  const formulas = extractFormulas(body);

  return {
    title,
    abstract,
    sections,
    references,
    tables,
    formulas,
    parserUsed: 'grobid',
    parseDurationMs,
  };
}

function extractTitle(header: Record<string, unknown>): string {
  const fileDesc = nested(header, 'fileDesc') as Record<string, unknown> | undefined;
  const titleStmt = nested(fileDesc, 'titleStmt') as Record<string, unknown> | undefined;
  const title = nested(titleStmt, 'title');
  return textContent(title);
}

function extractAbstract(header: Record<string, unknown>): string {
  const profileDesc = nested(header, 'profileDesc') as Record<string, unknown> | undefined;
  const abstract = nested(profileDesc, 'abstract') as Record<string, unknown> | undefined;
  if (!abstract) return '';

  // GROBID wraps abstract in <div><p>...</p></div>
  // abstract.div can be an array of divs, each containing p elements
  const divNode = abstract.div;
  const divs = divNode ? (Array.isArray(divNode) ? divNode : [divNode]) : [];

  const allParagraphs: unknown[] = [];

  for (const d of divs) {
    const div = d as Record<string, unknown>;
    const ps = div.p;
    if (ps) {
      const pArr = Array.isArray(ps) ? ps : [ps];
      allParagraphs.push(...pArr);
    }
  }

  // Also check direct abstract.p (some GROBID versions)
  if (allParagraphs.length === 0 && abstract.p) {
    const ps = abstract.p;
    const pArr = Array.isArray(ps) ? ps : [ps];
    allParagraphs.push(...pArr);
  }

  if (allParagraphs.length > 0) {
    return allParagraphs.map(textContent).join('\n\n');
  }

  // Fallback: extract all text from abstract
  return textContent(abstract);
}

function extractSections(body: Record<string, unknown>): ParsedSection[] {
  const divs = body.div;
  if (!divs) return [];

  const divArray = Array.isArray(divs) ? divs : [divs];

  // Parse all divs into flat sections with numbering info
  const flat = divArray.map((div, i) => parseDivFlat(div as Record<string, unknown>, i));

  // Rebuild hierarchy from <head n="3.2.1"> numbering
  return buildSectionHierarchy(flat);
}

interface FlatSection {
  name: string;
  content: string;
  numbering: string | undefined; // "3", "3.1", "3.2.1"
  depth: number; // number of dots + 1, or 0 if no numbering
}

function parseDivFlat(div: Record<string, unknown>, index: number): FlatSection {
  // Extract numbering from <head n="..."> attribute
  const headNode = div.head;
  let numbering: string | undefined;
  if (headNode && typeof headNode === 'object' && !Array.isArray(headNode)) {
    const h = headNode as Record<string, unknown>;
    numbering = h['@_n'] as string | undefined;
  }

  const name = textContent(headNode) || `Section ${index + 1}`;

  // Collect paragraph text
  const paragraphs = div.p;
  const pArray = paragraphs ? (Array.isArray(paragraphs) ? paragraphs : [paragraphs]) : [];
  const content = pArray.map(textContent).filter(Boolean).join('\n\n');

  // Depth from numbering: "3" → 1, "3.1" → 2, "3.2.1" → 3
  const depth = numbering ? numbering.split('.').length : 0;

  return { name, content, numbering, depth };
}

function buildSectionHierarchy(flat: FlatSection[]): ParsedSection[] {
  const root: ParsedSection[] = [];
  // Stack of [section, depth] to track nesting context
  const stack: Array<{ section: ParsedSection; depth: number }> = [];

  for (const item of flat) {
    const section: ParsedSection = {
      name: item.name,
      content: item.content,
      level: item.depth || 1,
    };

    if (item.depth <= 1) {
      // Top-level section (depth 0 = no numbering, depth 1 = "1", "2", etc.)
      root.push(section);
      stack.length = 0;
      stack.push({ section, depth: item.depth || 1 });
    } else {
      // Find parent: pop stack until we find a section with lower depth
      while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) {
        stack.pop();
      }

      if (stack.length > 0) {
        const parent = stack[stack.length - 1].section;
        if (!parent.subsections) parent.subsections = [];
        parent.subsections.push(section);
      } else {
        // No parent found — treat as top-level
        root.push(section);
      }

      stack.push({ section, depth: item.depth });
    }
  }

  return root;
}

function extractReferences(back: Record<string, unknown>): ParsedReference[] {
  // References can be in back.div[].listBibl or directly back.listBibl
  let listBibl = nested(back, 'listBibl') as Record<string, unknown> | undefined;

  if (!listBibl) {
    const divs = back.div;
    if (divs) {
      const divArray = Array.isArray(divs) ? divs : [divs];
      for (const div of divArray) {
        const d = div as Record<string, unknown>;
        if (d.listBibl) {
          listBibl = d.listBibl as Record<string, unknown>;
          break;
        }
      }
    }
  }

  if (!listBibl) return [];

  const biblStructs = listBibl.biblStruct;
  if (!biblStructs) return [];

  const structs = Array.isArray(biblStructs) ? biblStructs : [biblStructs];
  return structs.map(parseReference).filter((r): r is ParsedReference => r !== null);
}

function parseReference(bib: unknown): ParsedReference | null {
  if (!bib || typeof bib !== 'object') return null;
  const b = bib as Record<string, unknown>;

  const analytic = (b.analytic ?? {}) as Record<string, unknown>;
  const monogr = (b.monogr ?? {}) as Record<string, unknown>;

  const title = textContent(nested(analytic, 'title') ?? nested(monogr, 'title'));
  const authors = extractAuthorNames(analytic.author ?? monogr.author);

  const imprint = nested(monogr, 'imprint') as Record<string, unknown> | undefined;
  const dateNode = nested(imprint, 'date');
  const yearStr =
    dateNode && typeof dateNode === 'object'
      ? (dateNode as Record<string, string>)['@_when']
      : undefined;
  const year = yearStr ? parseInt(yearStr, 10) : undefined;

  const doi = extractIdno(b, 'DOI') ?? extractIdno(analytic, 'DOI');

  const venue = textContent(nested(monogr, 'title'));

  // Build raw string
  const parts = [authors.join(', '), title, venue, year?.toString()].filter(Boolean);
  const raw = parts.join('. ') || textContent(bib);

  return { raw, title: title || undefined, authors, year, doi, venue: venue || undefined };
}

function extractAuthorNames(authorNode: unknown): string[] {
  if (!authorNode) return [];
  const authors = Array.isArray(authorNode) ? authorNode : [authorNode];
  return authors
    .map((a) => {
      if (typeof a !== 'object' || !a) return '';
      const author = a as Record<string, unknown>;
      const persName = author.persName as Record<string, unknown> | undefined;
      if (!persName) return '';
      const forename = textContent(persName.forename);
      const surname = textContent(persName.surname);
      return [forename, surname].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

function extractIdno(obj: Record<string, unknown>, type: string): string | undefined {
  const idno = obj.idno;
  if (!idno) return undefined;
  const idnos = Array.isArray(idno) ? idno : [idno];
  for (const id of idnos) {
    if (typeof id === 'object' && id) {
      const i = id as Record<string, string>;
      if (i['@_type'] === type) return textContent(i);
    }
  }
  return undefined;
}

function extractTables(body: Record<string, unknown>): ParsedTable[] {
  const tables: ParsedTable[] = [];
  collectTables(body, tables);
  return tables;
}

function collectTables(node: unknown, tables: ParsedTable[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;

  // Check for figure elements
  const figures = n.figure;
  if (figures) {
    const figArray = Array.isArray(figures) ? figures : [figures];
    for (const fig of figArray) {
      if (typeof fig === 'object' && fig) {
        const f = fig as Record<string, string>;
        if (f['@_type'] === 'table') {
          const table = parseTableFigure(fig as Record<string, unknown>);
          if (table) tables.push(table);
        }
      }
    }
  }

  // Recurse into divs
  const divs = n.div;
  if (divs) {
    const divArray = Array.isArray(divs) ? divs : [divs];
    for (const div of divArray) {
      collectTables(div, tables);
    }
  }
}

function parseTableFigure(fig: Record<string, unknown>): ParsedTable | null {
  const caption = textContent(fig.head);
  const tableNode = fig.table as Record<string, unknown> | undefined;
  if (!tableNode) return { caption: caption || undefined, headers: [], rows: [] };

  const rowNodes = tableNode.row;
  if (!rowNodes) return { caption: caption || undefined, headers: [], rows: [] };

  const rows = Array.isArray(rowNodes) ? rowNodes : [rowNodes];
  const parsedRows: string[][] = rows.map((row) => {
    const r = row as Record<string, unknown>;
    const cells = r.cell;
    if (!cells) return [];
    const cellArray = Array.isArray(cells) ? cells : [cells];
    return cellArray.map(textContent);
  });

  const headers = parsedRows.length > 0 ? parsedRows[0] : [];
  const dataRows = parsedRows.slice(1);

  return { caption: caption || undefined, headers, rows: dataRows };
}

function extractFormulas(body: Record<string, unknown>): ParsedFormula[] {
  const formulas: ParsedFormula[] = [];
  collectFormulas(body, formulas);
  return formulas;
}

function collectFormulas(node: unknown, formulas: ParsedFormula[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;

  const formulaNodes = n.formula;
  if (formulaNodes) {
    const fArray = Array.isArray(formulaNodes) ? formulaNodes : [formulaNodes];
    for (const f of fArray) {
      const raw = textContent(f);
      if (raw) {
        const label =
          typeof f === 'object' && f ? ((f as Record<string, string>)['@_xml:id'] ?? undefined) : undefined;
        formulas.push({ raw, label });
      }
    }
  }

  // Recurse into divs and paragraphs
  for (const key of ['div', 'p']) {
    const children = n[key];
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const child of arr) {
        collectFormulas(child, formulas);
      }
    }
  }
}

// ── Helpers ──

function nested(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

function textContent(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(' ').trim();
  if (typeof node === 'object') {
    // Object may have #text property (fast-xml-parser)
    const obj = node as Record<string, unknown>;
    if ('#text' in obj) return textContent(obj['#text']);
    // Fallback: concatenate all string values
    return Object.values(obj)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map(String)
      .join(' ')
      .trim();
  }
  return '';
}
