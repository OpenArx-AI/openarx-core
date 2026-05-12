/**
 * Semantic Scholar API client for external ID enrichment.
 *
 * Looks up papers by arXiv ID and returns DOI, S2 CorpusId, DBLP ID.
 * Free tier: 100 requests/5 min. Uses retry with backoff.
 */

import { createChildLogger } from './logger.js';

const log = createChildLogger('s2-client');

const S2_API = 'https://api.semanticscholar.org/graph/v1/paper';
const S2_API_KEY = process.env.S2_API_KEY ?? '';
const RATE_LIMIT_MS = S2_API_KEY ? 1100 : 3200; // With key: 1 RPS. Without: ~100 req/5 min

export interface S2ExternalIds {
  doi?: string;
  s2_id?: string;
  dblp?: string;
  mag?: string;
  corpus_id?: string;
}

/**
 * Look up external IDs for a paper via Semantic Scholar API.
 * Returns partial record — only fields that S2 has.
 */
export async function lookupS2Ids(arxivId: string): Promise<S2ExternalIds> {
  const url = `${S2_API}/arXiv:${arxivId}?fields=externalIds`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers: Record<string, string> = {};
      if (S2_API_KEY) headers['x-api-key'] = S2_API_KEY;
      const resp = await fetch(url, { headers });

      if (resp.status === 404) {
        return {}; // Paper not in S2
      }

      if (resp.status === 429) {
        const wait = RATE_LIMIT_MS * (attempt + 2);
        log.warn({ arxivId, attempt, wait }, 'S2 rate limited, waiting');
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!resp.ok) {
        log.warn({ arxivId, status: resp.status }, 'S2 API error');
        return {};
      }

      const data = (await resp.json()) as {
        paperId: string;
        externalIds: Record<string, string | number>;
      };

      const ext = data.externalIds ?? {};
      const result: S2ExternalIds = {};
      if (ext.DOI) result.doi = String(ext.DOI);
      if (data.paperId) result.s2_id = data.paperId;
      if (ext.DBLP) result.dblp = String(ext.DBLP);
      if (ext.MAG) result.mag = String(ext.MAG);
      if (ext.CorpusId) result.corpus_id = String(ext.CorpusId);

      return result;
    } catch (err) {
      if (attempt === 2) {
        log.error({ arxivId, err }, 'S2 lookup failed after 3 attempts');
        return {};
      }
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  return {};
}

/** Rate-limit delay between S2 API calls. */
export async function s2RateLimit(): Promise<void> {
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
}
