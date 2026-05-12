import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAlexClient, AuthError } from '../openalex.js';

// ── Mock fetch ──────────────────────────────────────────────

let mockResponses: Array<{ status: number; body: unknown }> = [];
let fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  mockResponses = [...responses];
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    const mock = mockResponses.shift();
    if (!mock) throw new Error('No mock response left');
    return {
      ok: mock.status >= 200 && mock.status < 300,
      status: mock.status,
      json: async () => mock.body,
      text: async () => JSON.stringify(mock.body),
    } as Response;
  }) as typeof fetch;
}

// ── Fixtures (based on real OpenAlex API responses 2026-04-12) ──

const WORK_ALPHAFOLD = {
  id: 'https://openalex.org/W3177828909',
  doi: 'https://doi.org/10.1038/s41586-021-03819-2',
  title: 'Highly accurate protein structure prediction with AlphaFold',
  open_access: {
    is_oa: true,
    oa_status: 'hybrid',
    oa_url: 'https://www.nature.com/articles/s41586-021-03819-2.pdf',
    any_repository_has_fulltext: true,
  },
  locations: [
    {
      is_oa: true,
      pdf_url: 'https://www.nature.com/articles/s41586-021-03819-2.pdf',
      landing_page_url: 'https://doi.org/10.1038/s41586-021-03819-2',
      license: 'cc-by',
      version: 'publishedVersion',
      source: { display_name: 'Nature', type: 'journal' },
    },
    {
      is_oa: false,
      pdf_url: null,
      landing_page_url: 'https://pubmed.ncbi.nlm.nih.gov/34265844',
      license: null,
      version: 'publishedVersion',
      source: { display_name: 'PubMed', type: 'repository' },
    },
    {
      is_oa: true,
      pdf_url: null,
      landing_page_url: 'https://europepmc.org/articles/pmc8371605',
      license: 'cc-by',
      version: 'submittedVersion',
      source: { display_name: 'PubMed Central', type: 'repository' },
    },
  ],
};

const WORK_CLOSED = {
  id: 'https://openalex.org/W3011502486',
  doi: 'https://doi.org/10.1117/12.2550651',
  open_access: {
    is_oa: false,
    oa_status: 'closed',
    oa_url: null,
    any_repository_has_fulltext: false,
  },
  locations: [
    {
      is_oa: false,
      pdf_url: null,
      landing_page_url: 'https://doi.org/10.1117/12.2550651',
      license: null,
      version: 'publishedVersion',
      source: null,
    },
  ],
};

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

const client = createOpenAlexClient({ email: 'hello@openarx.ai' });

describe('lookupByDoi', () => {
  test('success with OA locations (AlphaFold-like)', async () => {
    mockFetch([{ status: 200, body: WORK_ALPHAFOLD }]);

    const result = await client.lookupByDoi('10.1038/s41586-021-03819-2');

    assert.equal(result.status, 'success');
    assert.equal(result.doi, '10.1038/s41586-021-03819-2');
    assert.equal(result.openalexId, 'https://openalex.org/W3177828909');
    assert.equal(result.oaStatus, 'hybrid');
    assert.equal(result.locations.length, 3);

    const oaLoc = result.locations[0];
    assert.equal(oaLoc.pdfUrl, 'https://www.nature.com/articles/s41586-021-03819-2.pdf');
    assert.equal(oaLoc.license, 'cc-by');
    assert.equal(oaLoc.version, 'publishedVersion');
    assert.equal(oaLoc.sourceName, 'Nature');
    assert.equal(oaLoc.isOa, true);

    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes('doi:'));
    assert.ok(fetchCalls[0].includes('mailto=hello%40openarx.ai'));
  });

  test('success with closed access', async () => {
    mockFetch([{ status: 200, body: WORK_CLOSED }]);

    const result = await client.lookupByDoi('10.1117/12.2550651');

    assert.equal(result.status, 'success');
    assert.equal(result.oaStatus, 'closed');
    assert.equal(result.locations.length, 1);
    assert.equal(result.locations[0].isOa, false);
  });

  test('DOI prefix stripped from response', async () => {
    mockFetch([{ status: 200, body: WORK_ALPHAFOLD }]);
    const result = await client.lookupByDoi('10.1038/s41586-021-03819-2');
    assert.equal(result.doi, '10.1038/s41586-021-03819-2');
  });

  test('404 → not_found', async () => {
    mockFetch([{ status: 404, body: null }]);
    const result = await client.lookupByDoi('10.9999/nonexistent');
    assert.equal(result.status, 'not_found');
  });
});

describe('retry behavior (D3)', () => {
  test('429 retries then succeeds', async () => {
    mockFetch([
      { status: 429, body: null },
      { status: 200, body: WORK_ALPHAFOLD },
    ]);
    const result = await client.lookupByDoi('10.1038/s41586-021-03819-2');
    assert.equal(result.status, 'success');
    assert.equal(fetchCalls.length, 2);
  });

  test('500 x3 exhausts retries → throws', async () => {
    mockFetch([
      { status: 500, body: null },
      { status: 500, body: null },
      { status: 500, body: null },
    ]);
    await assert.rejects(
      () => client.lookupByDoi('10.1038/s41586-021-03819-2'),
      (err: Error) => err.message.includes('500'),
    );
    assert.equal(fetchCalls.length, 3);
  });
});

describe('auth error (D11)', () => {
  test('401 throws AuthError immediately', async () => {
    mockFetch([{ status: 401, body: null }]);
    await assert.rejects(
      () => client.lookupByDoi('10.1038/test'),
      (err: Error) => {
        assert.ok(err instanceof AuthError);
        return true;
      },
    );
    assert.equal(fetchCalls.length, 1);
  });
});
