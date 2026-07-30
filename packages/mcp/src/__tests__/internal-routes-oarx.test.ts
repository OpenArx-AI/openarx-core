/**
 * C3 (batch-2): GET /api/internal/documents/by-oarx-id/:oarxId resolver contract
 * (Portal smart-search) + the /documents/:id non-UUID → 404 robustness guard.
 * Mounts internal-routes against a stub pool + documentStore.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AppContext } from '../context.js';
import type { Document } from '@openarx/types';

const INTERNAL_SECRET = 'test-secret';
process.env.CORE_INTERNAL_SECRET = INTERNAL_SECRET;

const { registerInternalRoutes } = await import('../internal-routes.js');

const DOC_UUID = 'aaaaaaaa-0000-0000-0000-000000000000';
function makeDoc(): Document {
  return {
    id: DOC_UUID,
    oarxId: 'oarx-b04ac9fb2c990f23',
    title: 'A Paper',
    abstract: 'Abstract text',
    authors: [{ name: 'Ada L.' }],
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    status: 'ready',
    deletedAt: null,
    categories: [],
    sourceUrl: null,
  } as unknown as Document;
}

type QueryImpl = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

async function startServer(opts: { query: QueryImpl; getById: (id: string) => Promise<Document | null> }): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  const ctx = {
    pool: { query: opts.query },
    documentStore: { getById: opts.getById },
  } as unknown as AppContext;
  registerInternalRoutes(app, ctx);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const get = (port: number, path: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });

// resolver hit → the two buildDocumentDetail queries (chunk count + versions)
const detailQuery: QueryImpl = async (sql) => {
  if (/count\(\*\)/.test(sql)) return { rows: [{ count: '5' }] };
  if (/version, status, created_at/.test(sql)) return { rows: [] };
  return { rows: [] };
};

test('by-oarx-id: valid 16-hex → 200 with document (same /documents/:id shape)', async () => {
  const srv = await startServer({
    query: async (sql, params) => {
      if (/SELECT id FROM documents WHERE/.test(sql)) {
        assert.match(sql, /oarx_id = \$1/);
        assert.equal(params[0], 'oarx-b04ac9fb2c990f23');
        return { rows: [{ id: DOC_UUID }] };
      }
      return detailQuery(sql, params);
    },
    getById: async () => makeDoc(),
  });
  const r = await get(srv.port, '/api/internal/documents/by-oarx-id/oarx-b04ac9fb2c990f23');
  const j = (await r.json()) as { document?: { id: string; oarx_id: string; chunks_count: number; title: string } };
  assert.equal(r.status, 200);
  assert.equal(j.document?.id, DOC_UUID);
  assert.equal(j.document?.oarx_id, 'oarx-b04ac9fb2c990f23'); // echoed canonical id (Portal card)
  assert.equal(j.document?.chunks_count, 5);
  assert.equal(j.document?.title, 'A Paper');
  await srv.close();
});

test('by-oarx-id: malformed id → 400 invalid_oarx_id (no resolve query)', async () => {
  const srv = await startServer({ query: async () => ({ rows: [] }), getById: async () => null });
  const r = await get(srv.port, '/api/internal/documents/by-oarx-id/not-an-oarx-id');
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, 'invalid_oarx_id');
  await srv.close();
});

test('by-oarx-id: valid format but unknown → 404 not_found', async () => {
  const srv = await startServer({
    query: async (sql) => (/SELECT id FROM documents WHERE/.test(sql) ? { rows: [] } : { rows: [] }),
    getById: async () => null,
  });
  const r = await get(srv.port, '/api/internal/documents/by-oarx-id/oarx-b04ac9fb2c990f23');
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as { error: string }).error, 'not_found'); // aligned to /documents/:id taxonomy
  await srv.close();
});

test('by-oarx-id: legacy 8-hex → resolves via left(oarx_id,13)', async () => {
  const srv = await startServer({
    query: async (sql, params) => {
      if (/SELECT id FROM documents WHERE/.test(sql)) {
        assert.match(sql, /left\(oarx_id, 13\) = \$1/);
        return { rows: [{ id: DOC_UUID }] };
      }
      return detailQuery(sql, params);
    },
    getById: async () => makeDoc(),
  });
  const r = await get(srv.port, '/api/internal/documents/by-oarx-id/oarx-b04ac9fb');
  assert.equal(r.status, 200);
  await srv.close();
});

test('/documents/:id with non-UUID → 404 (not 500)', async () => {
  const srv = await startServer({ query: async () => ({ rows: [] }), getById: async () => null });
  const r = await get(srv.port, '/api/internal/documents/not-a-uuid');
  assert.equal(r.status, 404);
  await srv.close();
});

test('/documents/:id with a UUID → 200 (unchanged path)', async () => {
  const srv = await startServer({ query: detailQuery, getById: async () => makeDoc() });
  const r = await get(srv.port, `/api/internal/documents/${DOC_UUID}`);
  assert.equal(r.status, 200);
  await srv.close();
});
