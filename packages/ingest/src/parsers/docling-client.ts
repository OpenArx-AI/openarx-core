/**
 * Docling parser client.
 *
 * Sends PDF to Docling-serve /v1/convert/file endpoint,
 * parses JSON response into ParsedDocument.
 */

import { readFile } from 'node:fs/promises';
import type {
  ParsedDocument,
  ParsedSection,
  ParsedReference,
  ParsedTable,
  ParsedFormula,
} from '@openarx/types';
import { retry, type RetryOptions } from '../lib/retry.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('docling');

export interface DoclingClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retry?: RetryOptions;
}

const DEFAULTS = {
  baseUrl: 'http://localhost:5001',
  timeoutMs: 180_000, // 3 min — Docling can be slow on large papers
};

export async function checkDoclingHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function parseWithDocling(
  pdfPath: string,
  opts?: Partial<DoclingClientOptions>,
): Promise<ParsedDocument> {
  const baseUrl = opts?.baseUrl ?? DEFAULTS.baseUrl;
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;

  const start = performance.now();

  const json = await retry(
    async () => {
      const pdfBuffer = await readFile(pdfPath);
      const form = new FormData();
      form.append(
        'files',
        new Blob([pdfBuffer], { type: 'application/pdf' }),
        'paper.pdf',
      );
      form.append('to_formats', 'json');

      // Use async endpoint to avoid 120s sync timeout
      const submitResp = await fetch(`${baseUrl}/v1/convert/file/async`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (!submitResp.ok) {
        const body = await submitResp.text().catch(() => '');
        throw new Error(`Docling submit error ${submitResp.status}: ${body.slice(0, 200)}`);
      }

      const submitResult = (await submitResp.json()) as { task_id: string };
      const taskId = submitResult.task_id;
      log.debug({ taskId, pdfPath }, 'Docling async task submitted');

      // Poll for completion
      const deadline = Date.now() + timeoutMs;
      const pollIntervalMs = 5_000;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));

        const statusResp = await fetch(`${baseUrl}/v1/status/poll/${taskId}`, {
          signal: AbortSignal.timeout(10_000),
        });

        if (!statusResp.ok) {
          log.warn({ taskId, status: statusResp.status }, 'Poll status request failed');
          continue;
        }

        const statusResult = (await statusResp.json()) as { task_status: string };

        if (statusResult.task_status === 'success') {
          const resultResp = await fetch(`${baseUrl}/v1/result/${taskId}`, {
            signal: AbortSignal.timeout(30_000),
          });

          if (!resultResp.ok) {
            throw new Error(`Docling result fetch error ${resultResp.status}`);
          }

          return (await resultResp.json()) as DoclingResponse;
        }

        if (statusResult.task_status === 'failure') {
          throw new Error(`Docling async task failed: ${taskId}`);
        }

        log.debug({ taskId, status: statusResult.task_status }, 'Polling...');
      }

      throw new Error(`Docling async task timed out after ${timeoutMs}ms: ${taskId}`);
    },
    `docling:${pdfPath}`,
    opts?.retry,
  );

  const parseDurationMs = Math.round(performance.now() - start);
  log.info({ pdfPath, parseDurationMs }, 'Docling parse complete');

  return parseDoclingResponse(json, parseDurationMs);
}

// ── Docling JSON types (minimal, what we actually use) ──

interface DoclingResponse {
  document?: DoclingDocumentWrapper;
  // Some versions return an array of results
  [key: string]: unknown;
}

interface DoclingDocumentWrapper {
  json_content?: DoclingDocument;
  md_content?: string;
  [key: string]: unknown;
}

interface DoclingDocument {
  texts?: DoclingText[];
  tables?: DoclingTable[];
  body?: DoclingNode;
  [key: string]: unknown;
}

interface DoclingText {
  self_ref?: string;
  parent?: { $ref: string };
  children?: { $ref: string }[];
  label?: string;
  text?: string;
  [key: string]: unknown;
}

interface DoclingTable {
  self_ref?: string;
  parent?: { $ref: string };
  label?: string;
  data?: DoclingTableData;
  captions?: DoclingText[];
  [key: string]: unknown;
}

interface DoclingTableData {
  num_cols?: number;
  num_rows?: number;
  table_cells?: DoclingTableCell[];
  [key: string]: unknown;
}

interface DoclingTableCell {
  text?: string;
  row_span?: number;
  col_span?: number;
  start_row_offset_idx?: number;
  end_row_offset_idx?: number;
  start_col_offset_idx?: number;
  end_col_offset_idx?: number;
  column_header?: boolean;
  row_header?: boolean;
  [key: string]: unknown;
}

interface DoclingNode {
  self_ref?: string;
  children?: { $ref: string }[];
  [key: string]: unknown;
}

// ── Response parsing ──

function parseDoclingResponse(resp: DoclingResponse, parseDurationMs: number): ParsedDocument {
  // Handle different response shapes
  const docWrapper = resp.document ?? (resp as unknown as DoclingDocumentWrapper);
  const docContent = docWrapper.json_content ?? (docWrapper as unknown as DoclingDocument);

  const texts = docContent.texts ?? [];
  const tables = docContent.tables ?? [];

  const title = extractTitle(texts);
  const abstract = extractAbstract(texts);
  const sections = buildSections(texts);
  const references = extractReferences(texts);
  const parsedTables = tables.map(parseTable);
  const formulas = extractFormulas(texts);

  return {
    title,
    abstract,
    sections,
    references,
    tables: parsedTables,
    formulas,
    parserUsed: 'docling',
    parseDurationMs,
  };
}

function extractTitle(texts: DoclingText[]): string {
  // Docling uses 'section_header' for the title (first one, before any 'text' blocks)
  // Also check 'title' and 'document_title' for forward compatibility
  const titleText = texts.find(
    (t) =>
      t.label === 'title' ||
      t.label === 'document_title' ||
      t.label === 'section_header',
  );
  return titleText?.text?.trim() ?? '';
}

function extractAbstract(texts: DoclingText[]): string {
  // Find paragraphs after "Abstract" heading and before the next section heading
  let inAbstract = false;
  const parts: string[] = [];

  for (const t of texts) {
    if (t.label === 'section_header' || t.label === 'section_heading' || t.label === 'title') {
      if (inAbstract) break;
      if (t.text?.toLowerCase().includes('abstract')) {
        inAbstract = true;
        continue;
      }
    }
    if (inAbstract && (t.label === 'text' || t.label === 'paragraph')) {
      if (t.text) parts.push(t.text.trim());
    }
  }

  return parts.join('\n\n');
}

function buildSections(texts: DoclingText[]): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const t of texts) {
    if (t.label === 'section_header' || t.label === 'section_heading') {
      if (current) sections.push(current);
      current = {
        name: t.text?.trim() ?? 'Untitled',
        content: '',
        level: guessSectionLevel(t.text ?? ''),
      };
    } else if (
      (t.label === 'text' || t.label === 'paragraph' || t.label === 'list_item') &&
      current
    ) {
      if (current.content) current.content += '\n\n';
      current.content += t.text?.trim() ?? '';
    }
  }

  if (current) sections.push(current);

  // Filter out abstract section if present (handled separately)
  return sections.filter((s) => !s.name.toLowerCase().includes('abstract'));
}

function guessSectionLevel(heading: string): number {
  // Try to parse numbered headings like "1.", "1.1", "1.1.1"
  const match = heading.match(/^(\d+(?:\.\d+)*)/);
  if (match) {
    return match[1].split('.').length;
  }
  return 1;
}

function extractReferences(texts: DoclingText[]): ParsedReference[] {
  // References are usually paragraphs after "References" heading
  let inReferences = false;
  const refs: ParsedReference[] = [];

  for (const t of texts) {
    if (t.label === 'section_header' || t.label === 'section_heading') {
      const heading = t.text?.toLowerCase() ?? '';
      inReferences = heading.includes('references') || heading.includes('bibliography');
      continue;
    }
    if (inReferences && t.text) {
      refs.push({ raw: t.text.trim() });
    }
  }

  return refs;
}

function parseTable(table: DoclingTable): ParsedTable {
  const caption = table.captions?.[0]?.text?.trim();
  const data = table.data;

  if (!data?.table_cells || !data.num_cols) {
    return { caption, headers: [], rows: [] };
  }

  const numRows = data.num_rows ?? 0;
  const numCols = data.num_cols;

  // Build grid
  const grid: string[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => ''),
  );

  for (const cell of data.table_cells) {
    const row = cell.start_row_offset_idx ?? 0;
    const col = cell.start_col_offset_idx ?? 0;
    if (row < numRows && col < numCols) {
      grid[row][col] = cell.text?.trim() ?? '';
    }
  }

  // First row with column_header cells = headers
  const headerCells = data.table_cells.filter((c) => c.column_header);
  const headers = headerCells.length > 0 ? grid[0] : [];
  const dataStart = headerCells.length > 0 ? 1 : 0;

  return {
    caption,
    headers,
    rows: grid.slice(dataStart),
  };
}

function extractFormulas(texts: DoclingText[]): ParsedFormula[] {
  return texts
    .filter((t) => t.label === 'formula' || t.label === 'equation')
    .map((t) => ({
      raw: t.text?.trim() ?? '',
    }))
    .filter((f) => f.raw.length > 0);
}
