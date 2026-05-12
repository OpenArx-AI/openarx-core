/**
 * Mathpix parser — PDF → Markdown → ParsedDocument.
 *
 * Uploads PDF to Mathpix API, polls until completed, downloads markdown,
 * parses into ParsedDocument with section hierarchy.
 *
 * Cost: $0.005/page. Used selectively for math-heavy papers.
 */

import { readFile } from 'node:fs/promises';
import type { ParsedDocument } from '@openarx/types';
import { createChildLogger } from '../lib/logger.js';
import { parseMarkdown } from './markdown-parser.js';

const log = createChildLogger('mathpix');

const API_BASE = 'https://api.mathpix.com/v3';
const COST_PER_PAGE = 0.005;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 120; // 6 minutes max

export interface MathpixConfig {
  appId: string;
  appKey: string;
}

function getMathpixConfig(): MathpixConfig {
  const appId = process.env.MATHPIX_APP_ID;
  const appKey = process.env.MATHPIX_APP_KEY;
  if (!appId || !appKey) {
    throw new Error('MATHPIX_APP_ID and MATHPIX_APP_KEY are required');
  }
  return { appId, appKey };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MathpixSubmitResponse {
  pdf_id: string;
}

interface MathpixStatusResponse {
  pdf_id: string;
  status: string;
  num_pages?: number;
  num_pages_completed?: number;
  percent_done?: number;
  error?: string;
}

export async function parseWithMathpix(
  pdfPath: string,
  config?: MathpixConfig,
): Promise<{ parsed: ParsedDocument; numPages: number }> {
  const { appId, appKey } = config ?? getMathpixConfig();
  const headers = { app_id: appId, app_key: appKey };
  const start = performance.now();

  // Step 1: Submit PDF
  const pdfBuffer = await readFile(pdfPath);
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'paper.pdf');
  form.append(
    'options_json',
    JSON.stringify({
      conversion_formats: { md: true },
      math_inline_delimiters: ['$', '$'],
      math_display_delimiters: ['$$', '$$'],
    }),
  );

  const submitResp = await fetch(`${API_BASE}/pdf`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!submitResp.ok) {
    const body = await submitResp.text().catch(() => '');
    throw new Error(`Mathpix submit failed ${submitResp.status}: ${body.slice(0, 200)}`);
  }

  const { pdf_id } = (await submitResp.json()) as MathpixSubmitResponse;
  log.info({ pdfPath, pdfId: pdf_id }, 'Mathpix PDF submitted');

  // Step 2: Poll until completed
  let numPages = 0;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const statusResp = await fetch(`${API_BASE}/pdf/${pdf_id}`, { headers });
    if (!statusResp.ok) {
      throw new Error(`Mathpix status check failed: ${statusResp.status}`);
    }

    const status = (await statusResp.json()) as MathpixStatusResponse;

    if (status.status === 'completed') {
      numPages = status.num_pages ?? 0;
      log.info({ pdfId: pdf_id, numPages, percent: status.percent_done }, 'Mathpix processing completed');
      break;
    }

    if (status.status === 'error') {
      throw new Error(`Mathpix processing error: ${status.error ?? 'unknown'}`);
    }

    if (attempt === MAX_POLL_ATTEMPTS - 1) {
      throw new Error(`Mathpix polling timeout after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
    }

    log.debug({ pdfId: pdf_id, percent: status.percent_done }, 'Mathpix processing...');
  }

  // Step 3: Download markdown
  const mdResp = await fetch(`${API_BASE}/pdf/${pdf_id}.md`, { headers });
  if (!mdResp.ok) {
    throw new Error(`Mathpix markdown download failed: ${mdResp.status}`);
  }

  const markdown = await mdResp.text();
  const parseDurationMs = Math.round(performance.now() - start);

  log.info({ pdfPath, parseDurationMs, numPages, mdLength: markdown.length }, 'Mathpix parse complete');

  const parsed = parseMarkdown(markdown, { parserUsed: 'mathpix', parseDurationMs });
  return { parsed, numPages };
}
