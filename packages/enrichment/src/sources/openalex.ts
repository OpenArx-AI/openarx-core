/**
 * OpenAlex HTTP client — lookup papers by arXiv ID or DOI.
 *
 * Lookup by published DOI only — OpenAlex does NOT support arXiv ID filters
 * or arXiv DOIs (10.48550/arXiv.*). Requires published DOI from external_ids.
 *
 * API: https://docs.openalex.org/api-entities/works
 * Rate: 100K/day with polite pool (mailto param), 10/sec without.
 * License: CC0 metadata.
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D2, D3, D11)
 */

import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('openalex');
const BASE_URL = 'https://api.openalex.org';
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface OpenAlexLocation {
  pdfUrl: string | null;
  landingPageUrl: string | null;
  license: string | null;
  version: string | null;
  sourceName: string | null;
  sourceType: string | null;
  isOa: boolean;
}

export interface OpenAlexResult {
  status: 'success' | 'not_found' | 'error';
  doi: string | null;
  openalexId: string | null;
  oaStatus: string | null;
  locations: OpenAlexLocation[];
  raw: unknown;
}

export interface OpenAlexClientConfig {
  email: string;
}

export interface OpenAlexClient {
  lookupByDoi(doi: string): Promise<OpenAlexResult>;
}

function mapLocation(loc: Record<string, unknown>): OpenAlexLocation {
  const source = loc.source as Record<string, unknown> | null;
  return {
    pdfUrl: (loc.pdf_url as string) ?? null,
    landingPageUrl: (loc.landing_page_url as string) ?? null,
    license: (loc.license as string) ?? null,
    version: (loc.version as string) ?? null,
    sourceName: source ? (source.display_name as string) ?? null : null,
    sourceType: source ? (source.type as string) ?? null : null,
    isOa: (loc.is_oa as boolean) ?? false,
  };
}

function parseWork(data: Record<string, unknown>): OpenAlexResult {
  const openAccess = data.open_access as Record<string, unknown> | null;
  const rawLocations = (data.locations ?? data.best_oa_location ? [data.best_oa_location] : []) as Array<Record<string, unknown>>;
  const locationsArr = Array.isArray(data.locations) ? data.locations as Array<Record<string, unknown>> : [];

  // Extract DOI — strip https://doi.org/ prefix if present
  let doi = (data.doi as string) ?? null;
  if (doi?.startsWith('https://doi.org/')) {
    doi = doi.slice('https://doi.org/'.length);
  }

  return {
    status: 'success',
    doi,
    openalexId: (data.id as string) ?? null,
    oaStatus: openAccess ? (openAccess.oa_status as string) ?? null : null,
    locations: locationsArr.map(mapLocation),
    raw: data,
  };
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
        headers: { 'User-Agent': 'OpenArx Research Indexer (https://openarx.com)' },
      });

      if (resp.status === 401 || resp.status === 403) {
        throw new AuthError(`OpenAlex auth error: HTTP ${resp.status}`);
      }

      if (resp.status === 404) {
        return { status: 404, data: null };
      }

      if (resp.status === 429 || resp.status >= 500) {
        const waitMs = RETRY_BASE_MS * Math.pow(2, i);
        lastError = new Error(`OpenAlex HTTP ${resp.status}`);
        if (i < attempts - 1) {
          log.warn({ url: url.slice(0, 120), attempt: i + 1, httpStatus: resp.status, waitMs }, 'retry');
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        log.error({ url: url.slice(0, 120), httpStatus: resp.status, attempts }, 'failed after retries');
        throw lastError;
      }

      if (!resp.ok) {
        throw new Error(`OpenAlex HTTP ${resp.status}`);
      }

      const data = await resp.json();
      return { status: resp.status, data };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        const waitMs = RETRY_BASE_MS * Math.pow(2, i);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
    }
  }

  throw lastError ?? new Error('OpenAlex fetch failed');
}

export function createOpenAlexClient(config: OpenAlexClientConfig): OpenAlexClient {
  const mailto = encodeURIComponent(config.email);

  async function lookupByDoi(doi: string): Promise<OpenAlexResult> {
    const url = `${BASE_URL}/works/doi:${encodeURIComponent(doi)}?mailto=${mailto}`;
    log.debug({ doi, url: url.slice(0, 120) }, 'request');

    const start = Date.now();
    const { status, data } = await fetchWithRetry(url);
    const durationMs = Date.now() - start;

    if (status === 404) {
      log.debug({ doi, durationMs }, 'not_found');
      return { status: 'not_found', doi, openalexId: null, oaStatus: null, locations: [], raw: null };
    }

    const result = parseWork(data as Record<string, unknown>);
    log.debug({ doi, status: result.status, oaStatus: result.oaStatus, locationsCount: result.locations.length, durationMs }, 'response');
    return result;
  }

  return { lookupByDoi };
}
