/**
 * PubMed Central (PMC) HTTP client — find OA biomedical papers by DOI.
 *
 * Two-step lookup:
 * 1. ID converter: DOI → pmcid (https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/)
 * 2. Construct PDF URL from pmcid (https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/pdf/)
 *
 * No API key required. Soft rate limit ~5 req/sec.
 * All papers in PMC OA subset are under CC licenses (NIH mandate).
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D1, D3)
 */

import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('pmc');
// NOTE: old URL (www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/) returns 301.
// New canonical endpoint as of 2025+:
const IDCONV_URL = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles';
const PMC_PDF_BASE = 'https://www.ncbi.nlm.nih.gov/pmc/articles';
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface PmcResult {
  status: 'success' | 'not_found' | 'error';
  doi: string;
  pmcid: string | null;
  pmid: string | null;
  pdfUrl: string | null;
  license: string | null;
  raw: unknown;
}

export interface PmcClient {
  lookup(doi: string): Promise<PmcResult>;
}

async function fetchWithRetry(
  url: string,
  attempts: number = RETRY_ATTEMPTS,
): Promise<{ status: number; data: unknown }> {
  let lastError: Error | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'User-Agent': 'OpenArx Research Indexer (https://openarx.com; hello@openarx.ai)',
        },
      });

      if (resp.status === 404) {
        return { status: 404, data: null };
      }

      if (resp.status === 429 || resp.status >= 500) {
        lastError = new Error(`PMC HTTP ${resp.status}`);
        if (i < attempts - 1) {
          const waitMs = RETRY_BASE_MS * Math.pow(2, i);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw lastError;
      }

      if (!resp.ok) {
        throw new Error(`PMC HTTP ${resp.status}`);
      }

      const data = await resp.json();
      return { status: resp.status, data };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        const waitMs = RETRY_BASE_MS * Math.pow(2, i);
        log.warn({ url: url.slice(0, 120), attempt: i + 1, error: lastError.message, waitMs }, 'retry');
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
    }
  }

  throw lastError ?? new Error('PMC fetch failed');
}

export function createPmcClient(): PmcClient {
  async function lookup(doi: string): Promise<PmcResult> {
    // Step 1: ID converter — DOI → pmcid
    const idconvUrl = `${IDCONV_URL}/?ids=${encodeURIComponent(doi)}&format=json&tool=openarx&email=hello@openarx.ai`;
    log.debug({ doi }, 'request');

    const start = Date.now();
    const { status, data } = await fetchWithRetry(idconvUrl);
    const durationMs = Date.now() - start;

    if (status === 404) {
      log.debug({ doi, durationMs }, 'not_found');
      return { status: 'not_found', doi, pmcid: null, pmid: null, pdfUrl: null, license: null, raw: null };
    }

    const body = data as Record<string, unknown>;
    const records = Array.isArray(body.records) ? body.records as Array<Record<string, unknown>> : [];

    if (records.length === 0) {
      return { status: 'not_found', doi, pmcid: null, pmid: null, pdfUrl: null, license: null, raw: body };
    }

    const record = records[0];

    // Check for error status (DOI not found in PMC)
    // Real response: {"doi":"...","requested-id":"...","status":"error","errmsg":"Identifier not found in PMC"}
    if (record.status === 'error' || record.errmsg) {
      const pmid = record.pmid != null ? String(record.pmid) : null;
      return { status: 'not_found', doi, pmcid: null, pmid, pdfUrl: null, license: null, raw: body };
    }

    const pmcid = (record.pmcid as string) ?? null;
    const pmid = record.pmid != null ? String(record.pmid) : null;

    if (!pmcid) {
      // DOI exists in PubMed but not in PMC OA subset
      return { status: 'not_found', doi, pmcid: null, pmid, pdfUrl: null, license: null, raw: body };
    }

    // Step 2: construct PDF URL from pmcid
    const pdfUrl = `${PMC_PDF_BASE}/${pmcid}/pdf/`;
    log.debug({ doi, pmcid, pmid, pdfUrl, durationMs }, 'response');

    // PMC idconv does NOT return license. PMC OA subset papers are typically
    // CC-BY (NIH Public Access Policy). Exact license per-article requires
    // additional efetch API call — for now record null, normalizer handles downstream.
    const license: string | null = null;

    return {
      status: 'success',
      doi,
      pmcid,
      pmid,
      pdfUrl,
      license,
      raw: body,
    };
  }

  return { lookup };
}
