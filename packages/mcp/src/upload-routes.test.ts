/**
 * openarx-contracts-xuqi: PUT /api/upload/{file_id} integration.
 *
 * Runs the real route on an in-process Express app with a stubbed pool (no
 * Postgres). Covers acceptance 2–6: happy path, bad/expired signature,
 * size cap, magic-byte mismatch, plus unknown/already-uploaded rows.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AppContext } from './context.js';

// Env must be set BEFORE importing the modules under test: upload-signing reads
// CORE_INTERNAL_SECRET lazily but upload-routes reads UPLOAD_MAX_BYTES and
// upload-paths reads PORTAL_STORAGE_BASE at module load.
const STORAGE = await mkdtemp(join(tmpdir(), 'oarx-upload-test-'));
process.env.CORE_INTERNAL_SECRET = 'test-secret-upload-routes';
process.env.PORTAL_STORAGE_BASE = STORAGE;
process.env.UPLOAD_MAX_BYTES = '1024'; // small cap so the 413 path needs only ~2 KB

const { registerUploadRoutes } = await import('./upload-routes.js');
const { signUpload } = await import('./lib/upload-signing.js');

const USER = '00000000-0000-0000-0000-000000000001';

after(async () => { await rm(STORAGE, { recursive: true, force: true }); });

interface StubRow { user_id: string; filled_at: Date | null; expected_content_type: string | null }

interface Harness { port: number; updates: unknown[][]; close: () => Promise<void> }

/** Spin up the route with a pool stub returning `row` for SELECT. */
async function start(row: StubRow | null): Promise<Harness> {
  const updates: unknown[][] = [];
  const ctx = {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        if (/^SELECT/i.test(sql.trim())) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        if (/^UPDATE/i.test(sql.trim())) { updates.push(params ?? []); return { rows: [], rowCount: row && row.filled_at == null ? 1 : 0 }; }
        return { rows: [], rowCount: 0 };
      },
    },
  } as unknown as AppContext;

  const app = express();
  registerUploadRoutes(app, ctx);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, updates, close: () => new Promise((r) => server.close(() => r())) };
}

function url(port: number, fileId: string, expiresUnix: number, sig: string): string {
  return `http://127.0.0.1:${port}/api/upload/${fileId}?expires=${expiresUnix}&signature=${sig}`;
}

const futureExpiry = (): number => Math.floor(Date.now() / 1000) + 600;
const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('valid PUT writes the file, records the fill, returns sha256 (acceptance 2)', async () => {
  const h = await start({ user_id: USER, filled_at: null, expected_content_type: null });
  const exp = futureExpiry();
  const body = Buffer.from('\\documentclass{article}\n\\begin{document}hi\\end{document}', 'latin1');
  const resp = await fetch(url(h.port, FILE_ID, exp, signUpload(FILE_ID, exp)), { method: 'PUT', body });
  const json = await resp.json() as Record<string, unknown>;
  assert.equal(resp.status, 200, JSON.stringify(json));
  assert.equal(json.size_bytes, body.length);
  assert.equal(json.sha256, createHash('sha256').update(body).digest('hex'));
  const onDisk = await readFile(join(STORAGE, USER, '.uploads', FILE_ID));
  assert.deepEqual(onDisk, body);
  assert.equal(h.updates.length, 1, 'fill UPDATE recorded');
  await h.close();
});

test('bad signature → 401 (acceptance 3)', async () => {
  const h = await start({ user_id: USER, filled_at: null, expected_content_type: null });
  const exp = futureExpiry();
  const resp = await fetch(url(h.port, FILE_ID, exp, 'deadbeef'.repeat(8)), { method: 'PUT', body: Buffer.from('x') });
  assert.equal(resp.status, 401);
  await h.close();
});

test('expired signature → 401 (acceptance 4)', async () => {
  const h = await start({ user_id: USER, filled_at: null, expected_content_type: null });
  const past = Math.floor(Date.now() / 1000) - 10;
  const resp = await fetch(url(h.port, FILE_ID, past, signUpload(FILE_ID, past)), { method: 'PUT', body: Buffer.from('x') });
  assert.equal(resp.status, 401);
  await h.close();
});

test('over the size cap → 413 (acceptance 5)', async () => {
  const h = await start({ user_id: USER, filled_at: null, expected_content_type: null });
  const exp = futureExpiry();
  const body = Buffer.alloc(2048, 0x61); // 2 KB > 1 KB cap, all 'a' (text, passes magic)
  const resp = await fetch(url(h.port, FILE_ID, exp, signUpload(FILE_ID, exp)), { method: 'PUT', body });
  assert.equal(resp.status, 413);
  await h.close();
});

test('declared zip but non-zip bytes → 400 magic mismatch (acceptance 6)', async () => {
  const h = await start({ user_id: USER, filled_at: null, expected_content_type: 'application/zip' });
  const exp = futureExpiry();
  const resp = await fetch(url(h.port, FILE_ID, exp, signUpload(FILE_ID, exp)), { method: 'PUT', body: Buffer.from('not a zip at all') });
  const json = await resp.json() as Record<string, unknown>;
  assert.equal(resp.status, 400);
  assert.equal(json.error, 'magic_byte_mismatch');
  await h.close();
});

test('unknown file_id → 404', async () => {
  const h = await start(null);
  const exp = futureExpiry();
  const resp = await fetch(url(h.port, FILE_ID, exp, signUpload(FILE_ID, exp)), { method: 'PUT', body: Buffer.from('x') });
  assert.equal(resp.status, 404);
  await h.close();
});

test('already-uploaded row → 409', async () => {
  const h = await start({ user_id: USER, filled_at: new Date(), expected_content_type: null });
  const exp = futureExpiry();
  const resp = await fetch(url(h.port, FILE_ID, exp, signUpload(FILE_ID, exp)), { method: 'PUT', body: Buffer.from('x') });
  assert.equal(resp.status, 409);
  await h.close();
});
