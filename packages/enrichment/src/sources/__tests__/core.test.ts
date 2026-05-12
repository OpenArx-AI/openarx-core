import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient, AuthError } from '../core.js';

// ── Mock fetch ──────────────────────────────────────────────

let mockResponses: Array<{ status: number; body: unknown }> = [];
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
const originalFetch = globalThis.fetch;

function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  mockResponses = [...responses];
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = init?.headers as Record<string, string> ?? {};
    fetchCalls.push({ url, headers });
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

const WORK_WITH_FULLTEXT = {
  results: [
    {
      id: 12345678,
      doi: 'https://doi.org/10.1234/test.2024',
      downloadUrl: 'https://core.ac.uk/download/pdf/12345678.pdf',
      sourceFulltextUrls: [
        'https://repository.example.edu/fulltext.pdf',
      ],
      license: 'cc-by-4.0',
      publisher: 'Example Publisher',
      dataProviders: [
        { name: 'Example University Repository' },
      ],
    },
  ],
  totalHits: 1,
};

const WORK_NO_FULLTEXT = {
  results: [
    {
      id: 99999999,
      doi: '10.5678/closed.2024',
      downloadUrl: null,
      sourceFulltextUrls: [],
      license: null,
      publisher: 'Paywalled Publisher',
      dataProviders: [],
    },
  ],
  totalHits: 1,
};

const EMPTY_RESULTS = {
  results: [],
  totalHits: 0,
};

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

const client = createCoreClient({ apiKey: 'test-api-key-123' });

describe('constructor', () => {
  test('throws if apiKey is empty', () => {
    assert.throws(
      () => createCoreClient({ apiKey: '' }),
      (err: Error) => err.message.includes('CORE API key is required'),
    );
  });
});

describe('lookup', () => {
  test('success with fulltext — downloadUrl + sourceFulltextUrls', async () => {
    mockFetch([{ status: 200, body: WORK_WITH_FULLTEXT }]);

    const result = await client.lookup('10.1234/test.2024');

    assert.equal(result.status, 'success');
    assert.equal(result.doi, '10.1234/test.2024');
    assert.equal(result.coreId, '12345678');
    assert.equal(result.locations.length, 1);

    const loc = result.locations[0];
    assert.equal(loc.downloadUrl, 'https://core.ac.uk/download/pdf/12345678.pdf');
    assert.deepEqual(loc.sourceFulltextUrls, ['https://repository.example.edu/fulltext.pdf']);
    assert.equal(loc.license, 'cc-by-4.0');
    assert.equal(loc.publisher, 'Example Publisher');
    assert.equal(loc.repositoryName, 'Example University Repository');

    // Verify auth header sent
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].headers['Authorization'], 'Bearer test-api-key-123');
    assert.ok(fetchCalls[0].url.includes('doi:'));
  });

  test('success but no fulltext → empty locations', async () => {
    mockFetch([{ status: 200, body: WORK_NO_FULLTEXT }]);

    const result = await client.lookup('10.5678/closed.2024');

    assert.equal(result.status, 'success');
    assert.equal(result.doi, '10.5678/closed.2024');
    assert.equal(result.locations.length, 0);
  });

  test('empty results → not_found', async () => {
    mockFetch([{ status: 200, body: EMPTY_RESULTS }]);

    const result = await client.lookup('10.9999/nonexistent');

    assert.equal(result.status, 'not_found');
    assert.equal(result.locations.length, 0);
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
      { status: 200, body: WORK_WITH_FULLTEXT },
    ]);

    const result = await client.lookup('10.1234/test.2024');
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
      () => client.lookup('10.1234/test'),
      (err: Error) => err.message.includes('500'),
    );
    assert.equal(fetchCalls.length, 3);
  });
});

describe('auth error (D11)', () => {
  test('401 throws AuthError immediately', async () => {
    mockFetch([{ status: 401, body: null }]);

    await assert.rejects(
      () => client.lookup('10.1234/test'),
      (err: Error) => {
        assert.ok(err instanceof AuthError);
        return true;
      },
    );
    assert.equal(fetchCalls.length, 1);
  });

  test('403 throws AuthError immediately', async () => {
    mockFetch([{ status: 403, body: null }]);

    await assert.rejects(
      () => client.lookup('10.1234/test'),
      (err: Error) => err instanceof AuthError,
    );
  });
});
