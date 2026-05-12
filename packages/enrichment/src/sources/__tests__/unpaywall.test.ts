import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUnpaywallClient, AuthError } from '../unpaywall.js';

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

const RESPONSE_WITH_OA = {
  doi: '10.1234/test.2024',
  is_oa: true,
  best_oa_location: {
    url: 'https://repository.example.edu/paper.pdf',
    url_for_pdf: 'https://repository.example.edu/paper.pdf',
    url_for_landing_page: 'https://repository.example.edu/paper',
    license: 'cc-by',
    version: 'acceptedVersion',
    host_type: 'repository',
    repository_institution: 'Example University',
  },
  oa_locations: [
    {
      url: 'https://repository.example.edu/paper.pdf',
      url_for_pdf: 'https://repository.example.edu/paper.pdf',
      url_for_landing_page: 'https://repository.example.edu/paper',
      license: 'cc-by',
      version: 'acceptedVersion',
      host_type: 'repository',
      repository_institution: 'Example University',
    },
    {
      url: 'https://publisher.com/paper',
      url_for_pdf: null,
      url_for_landing_page: 'https://publisher.com/paper',
      license: null,
      version: 'publishedVersion',
      host_type: 'publisher',
      repository_institution: null,
    },
  ],
};

const RESPONSE_NO_OA = {
  doi: '10.5678/closed.2024',
  is_oa: false,
  best_oa_location: null,
  oa_locations: [],
};

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => { fetchCalls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

const client = createUnpaywallClient({ email: 'hello@openarx.ai' });

describe('lookup', () => {
  test('success with OA — best location + all locations', async () => {
    mockFetch([{ status: 200, body: RESPONSE_WITH_OA }]);

    const result = await client.lookup('10.1234/test.2024');

    assert.equal(result.status, 'success');
    assert.equal(result.doi, '10.1234/test.2024');
    assert.equal(result.isOa, true);

    assert.ok(result.bestLocation);
    assert.equal(result.bestLocation.url, 'https://repository.example.edu/paper.pdf');
    assert.equal(result.bestLocation.urlForPdf, 'https://repository.example.edu/paper.pdf');
    assert.equal(result.bestLocation.license, 'cc-by');
    assert.equal(result.bestLocation.version, 'acceptedVersion');
    assert.equal(result.bestLocation.hostType, 'repository');
    assert.equal(result.bestLocation.repositoryInstitution, 'Example University');

    assert.equal(result.allLocations.length, 2);
    assert.equal(result.allLocations[1].hostType, 'publisher');
    assert.equal(result.allLocations[1].license, null);

    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes('10.1234%2Ftest.2024'));
    assert.ok(fetchCalls[0].includes('email=hello%40openarx.ai'));
  });

  test('success without OA — closed paper', async () => {
    mockFetch([{ status: 200, body: RESPONSE_NO_OA }]);

    const result = await client.lookup('10.5678/closed.2024');

    assert.equal(result.status, 'success');
    assert.equal(result.isOa, false);
    assert.equal(result.bestLocation, null);
    assert.equal(result.allLocations.length, 0);
  });

  test('404 → not_found (DOI not in Unpaywall)', async () => {
    mockFetch([{ status: 404, body: null }]);

    const result = await client.lookup('10.9999/nonexistent');

    assert.equal(result.status, 'not_found');
    assert.equal(result.doi, '10.9999/nonexistent');
    assert.equal(result.isOa, false);
    assert.equal(result.bestLocation, null);
    assert.equal(result.allLocations.length, 0);
  });
});

describe('retry behavior (D3)', () => {
  test('429 retries then succeeds', async () => {
    mockFetch([
      { status: 429, body: null },
      { status: 200, body: RESPONSE_WITH_OA },
    ]);

    const result = await client.lookup('10.1234/test.2024');
    assert.equal(result.status, 'success');
    assert.equal(fetchCalls.length, 2);
  });

  test('500 retries then succeeds', async () => {
    mockFetch([
      { status: 500, body: null },
      { status: 200, body: RESPONSE_NO_OA },
    ]);

    const result = await client.lookup('10.5678/closed.2024');
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
