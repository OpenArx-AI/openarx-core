/**
 * CORE HTTP client — find OA papers via UK aggregator (10,000+ repositories).
 *
 * API: https://api.core.ac.uk/v3/search/works
 * Rate: depends on tier (start with 10K/day assumption).
 * Requires API key (registration at https://core.ac.uk/services/api).
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D1, D3, D11)
 */

import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('core');
// NOTE: trailing slash on endpoints is required — without it CORE returns 301 redirect
const BASE_URL = 'https://api.core.ac.uk/v3';
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface CoreLocation {
  downloadUrl: string | null;
  sourceFulltextUrls: string[];
  license: string | null;
  publisher: string | null;
  repositoryName: string | null;
}

export interface CoreResult {
  status: 'success' | 'not_found' | 'error';
  doi: string | null;
  coreId: string | null;
  locations: CoreLocation[];
  raw: unknown;
}

export interface CoreClientConfig {
  apiKey: string;
}

export interface CoreClient {
  lookup(doi: string): Promise<CoreResult>;
}

function mapWork(work: Record<string, unknown>): { coreId: string | null; doi: string | null; locations: CoreLocation[] } {
  const coreId = work.id != null ? String(work.id) : null;

  // Extract DOI — CORE may return with or without prefix
  let doi = (work.doi as string) ?? null;
  if (doi?.startsWith('https://doi.org/')) {
    doi = doi.slice('https://doi.org/'.length);
  }

  // CORE returns download_url at top level + sourceFulltextUrls array
  const downloadUrl = (work.downloadUrl as string) ?? null;
  const sourceUrls = Array.isArray(work.sourceFulltextUrls)
    ? (work.sourceFulltextUrls as string[]).filter(u => typeof u === 'string')
    : [];
  const license = (work.license as string) ?? null;
  const publisher = (work.publisher as string) ?? null;

  // Repository info may be nested in dataProviders
  const providers = Array.isArray(work.dataProviders) ? work.dataProviders as Array<Record<string, unknown>> : [];
  const repositoryName = providers.length > 0 ? (providers[0].name as string) ?? null : null;

  const locations: CoreLocation[] = [];

  // Primary location from downloadUrl
  if (downloadUrl || sourceUrls.length > 0) {
    locations.push({
      downloadUrl,
      sourceFulltextUrls: sourceUrls,
      license,
      publisher,
      repositoryName,
    });
  }

  return { coreId, doi, locations };
}

async function fetchWithRetry(
  url: string,
  apiKey: string,
  attempts: number = RETRY_ATTEMPTS,
): Promise<{ status: number; data: unknown }> {
  let lastError: Error | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'OpenArx Research Indexer (https://openarx.com; hello@openarx.ai)',
        },
      });

      if (resp.status === 401 || resp.status === 403) {
        throw new AuthError(`CORE auth error: HTTP ${resp.status}`);
      }

      if (resp.status === 404) {
        return { status: 404, data: null };
      }

      if (resp.status === 429 || resp.status >= 500) {
        lastError = new Error(`CORE HTTP ${resp.status}`);
        if (i < attempts - 1) {
          const waitMs = RETRY_BASE_MS * Math.pow(2, i);
          log.warn({ url: url.slice(0, 120), attempt: i + 1, httpStatus: resp.status, waitMs }, 'retry');
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        log.error({ url: url.slice(0, 120), httpStatus: resp.status, attempts }, 'failed after retries');
        throw lastError;
      }

      if (!resp.ok) {
        throw new Error(`CORE HTTP ${resp.status}`);
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

  throw lastError ?? new Error('CORE fetch failed');
}

export function createCoreClient(config: CoreClientConfig): CoreClient {
  if (!config.apiKey) {
    throw new Error('CORE API key is required (CORE_API_KEY env). Register at https://core.ac.uk/services/api');
  }

  const apiKey = config.apiKey;

  async function lookup(doi: string): Promise<CoreResult> {
    // Trailing slash required — without it CORE returns 301
    const url = `${BASE_URL}/search/works/?q=doi:"${encodeURIComponent(doi)}"&limit=1`;
    log.debug({ doi }, 'request');

    const start = Date.now();
    const { status, data } = await fetchWithRetry(url, apiKey);
    const durationMs = Date.now() - start;

    if (status === 404) {
      log.debug({ doi, durationMs }, 'not_found');
      return { status: 'not_found', doi, coreId: null, locations: [], raw: null };
    }

    const body = data as Record<string, unknown>;
    const results = Array.isArray(body.results) ? body.results as Array<Record<string, unknown>> : [];

    if (results.length === 0) {
      log.debug({ doi, durationMs }, 'not_found (empty results)');
      return { status: 'not_found', doi, coreId: null, locations: [], raw: body };
    }

    const { coreId, doi: resolvedDoi, locations } = mapWork(results[0]);
    log.debug({ doi, coreId, locationsCount: locations.length, durationMs }, 'response');

    return {
      status: 'success',
      doi: resolvedDoi ?? doi,
      coreId,
      locations,
      raw: body,
    };
  }

  return { lookup };
}
