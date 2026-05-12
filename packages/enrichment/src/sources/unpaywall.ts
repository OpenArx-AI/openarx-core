/**
 * Unpaywall HTTP client — find OA versions of papers by DOI.
 *
 * API: https://api.unpaywall.org/v2/{doi}?email={email}
 * Rate: 100K/day. No API key — only email param (identifies caller).
 * Default email: hello@openarx.ai (configurable via UNPAYWALL_EMAIL env).
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D3, D5, D11)
 */

import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('unpaywall');
const BASE_URL = 'https://api.unpaywall.org/v2';
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EMAIL = 'hello@openarx.ai';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface UnpaywallLocation {
  url: string;
  urlForPdf: string | null;
  urlForLandingPage: string;
  license: string | null;
  version: string | null;
  hostType: string | null;
  repositoryInstitution: string | null;
}

export interface UnpaywallResult {
  status: 'success' | 'not_found' | 'error';
  doi: string;
  isOa: boolean;
  bestLocation: UnpaywallLocation | null;
  allLocations: UnpaywallLocation[];
  raw: unknown;
}

export interface UnpaywallClientConfig {
  email?: string;
}

export interface UnpaywallClient {
  lookup(doi: string): Promise<UnpaywallResult>;
}

function mapLocation(loc: Record<string, unknown>): UnpaywallLocation {
  return {
    url: (loc.url as string) ?? '',
    urlForPdf: (loc.url_for_pdf as string) ?? null,
    urlForLandingPage: (loc.url_for_landing_page as string) ?? '',
    license: (loc.license as string) ?? null,
    version: (loc.version as string) ?? null,
    hostType: (loc.host_type as string) ?? null,
    repositoryInstitution: (loc.repository_institution as string) ?? null,
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
        headers: { 'User-Agent': 'OpenArx Research Indexer (https://openarx.com; hello@openarx.ai)' },
      });

      if (resp.status === 401 || resp.status === 403) {
        throw new AuthError(`Unpaywall auth error: HTTP ${resp.status}`);
      }

      if (resp.status === 404) {
        return { status: 404, data: null };
      }

      if (resp.status === 429 || resp.status >= 500) {
        lastError = new Error(`Unpaywall HTTP ${resp.status}`);
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
        throw new Error(`Unpaywall HTTP ${resp.status}`);
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

  throw lastError ?? new Error('Unpaywall fetch failed');
}

export function createUnpaywallClient(config?: UnpaywallClientConfig): UnpaywallClient {
  const email = encodeURIComponent(config?.email ?? process.env.UNPAYWALL_EMAIL ?? DEFAULT_EMAIL);

  async function lookup(doi: string): Promise<UnpaywallResult> {
    const url = `${BASE_URL}/${encodeURIComponent(doi)}?email=${email}`;
    log.debug({ doi }, 'request');

    const start = Date.now();
    const { status, data } = await fetchWithRetry(url);
    const durationMs = Date.now() - start;

    if (status === 404) {
      log.debug({ doi, durationMs }, 'not_found');
      return { status: 'not_found', doi, isOa: false, bestLocation: null, allLocations: [], raw: null };
    }

    const body = data as Record<string, unknown>;
    const isOa = (body.is_oa as boolean) ?? false;

    const bestRaw = body.best_oa_location as Record<string, unknown> | null;
    const bestLocation = bestRaw ? mapLocation(bestRaw) : null;

    const locationsRaw = Array.isArray(body.oa_locations)
      ? body.oa_locations as Array<Record<string, unknown>>
      : [];
    const allLocations = locationsRaw.map(mapLocation);

    log.debug({ doi, isOa, locationsCount: allLocations.length, bestLicense: bestLocation?.license, durationMs }, 'response');
    return { status: 'success', doi, isOa, bestLocation, allLocations, raw: body };
  }

  return { lookup };
}
