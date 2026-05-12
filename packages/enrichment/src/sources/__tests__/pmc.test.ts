import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPmcClient } from '../pmc.js';

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

// ── Fixtures ────────────────────────────────────────────────

// Fixtures based on real PMC idconv responses (2026-04-12)
// Real: {"doi":"10.1038/s41586-021-03819-2","pmcid":"PMC8371605","pmid":34265844,"requested-id":"10.1038/s41586-021-03819-2"}
const IDCONV_SUCCESS = {
  records: [
    {
      pmcid: 'PMC8371605',
      pmid: 34265844,
      doi: '10.1038/s41586-021-03819-2',
      'requested-id': '10.1038/s41586-021-03819-2',
    },
  ],
};

const IDCONV_NO_PMC = {
  records: [
    {
      pmid: 99999999,
      doi: '10.5678/nopmc.2024',
      'requested-id': '10.5678/nopmc.2024',
      // no pmcid — paper in PubMed but not PMC OA
    },
  ],
};

// Real: {"doi":"10.1214/21-aos2079","requested-id":"10.1214/21-aos2079","status":"error","errmsg":"Identifier not found in PMC"}
const IDCONV_ERROR = {
  records: [
    {
      doi: '10.9999/unknown',
      'requested-id': '10.9999/unknown',
      status: 'error',
      errmsg: 'Identifier not found in PMC',
    },
  ],
};

const IDCONV_EMPTY = {
  records: [],
};

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

const client = createPmcClient();

describe('lookup', () => {
  test('success — DOI resolves to pmcid + PDF URL constructed', async () => {
    mockFetch([{ status: 200, body: IDCONV_SUCCESS }]);

    const result = await client.lookup('10.1234/bio.2024');

    assert.equal(result.status, 'success');
    assert.equal(result.doi, '10.1234/bio.2024');
    assert.equal(result.pmcid, 'PMC8371605');
    assert.equal(result.pmid, '34265844');
    assert.equal(result.pdfUrl, 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8371605/pdf/');
    assert.equal(result.license, null); // PMC idconv does NOT return license

    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes('idconv'));
    assert.ok(fetchCalls[0].includes('10.1234%2Fbio.2024'));
    assert.ok(fetchCalls[0].includes('tool=openarx'));
  });

  test('DOI in PubMed but not PMC OA → not_found', async () => {
    mockFetch([{ status: 200, body: IDCONV_NO_PMC }]);

    const result = await client.lookup('10.5678/nopmc.2024');

    assert.equal(result.status, 'not_found');
    assert.equal(result.pmcid, null);
    assert.equal(result.pmid, '99999999'); // from fixture
    assert.equal(result.pdfUrl, null);
  });

  test('idconv error record → not_found', async () => {
    mockFetch([{ status: 200, body: IDCONV_ERROR }]);

    const result = await client.lookup('10.9999/unknown');

    assert.equal(result.status, 'not_found');
    assert.equal(result.pmcid, null);
  });

  test('empty records → not_found', async () => {
    mockFetch([{ status: 200, body: IDCONV_EMPTY }]);

    const result = await client.lookup('10.9999/empty');
    assert.equal(result.status, 'not_found');
  });

  test('404 → not_found', async () => {
    mockFetch([{ status: 404, body: null }]);

    const result = await client.lookup('10.9999/gone');
    assert.equal(result.status, 'not_found');
  });
});

describe('retry behavior (D3)', () => {
  test('429 retries then succeeds', async () => {
    mockFetch([
      { status: 429, body: null },
      { status: 200, body: IDCONV_SUCCESS },
    ]);

    const result = await client.lookup('10.1234/bio.2024');
    assert.equal(result.status, 'success');
    assert.equal(result.pmcid, 'PMC8371605');
    assert.equal(fetchCalls.length, 2);
  });

  test('500 x3 exhausts retries → throws', async () => {
    mockFetch([
      { status: 500, body: null },
      { status: 500, body: null },
      { status: 500, body: null },
    ]);

    await assert.rejects(
      () => client.lookup('10.1234/test'),
      (err: Error) => err.message.includes('500'),
    );
    assert.equal(fetchCalls.length, 3);
  });
});
