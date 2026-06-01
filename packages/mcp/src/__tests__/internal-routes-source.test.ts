/**
 * Integration tests for /documents/:id/download?format=latex (post lazy-extract)
 * and the new /documents/:id/source-file endpoint (openarx-yvkp part 2).
 *
 * Builds a real tar.gz fixture on disk, mounts internal-routes against a
 * stub documentStore that returns a doc pointing at it, and exercises the
 * serving paths end-to-end. Cleanup of scratch dirs runs in `after`.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppContext } from '../context.js';
import type { Document } from '@openarx/types';

const execFileAsync = promisify(execFile);

const INTERNAL_SECRET = 'test-secret';
process.env.CORE_INTERNAL_SECRET = INTERNAL_SECRET;

const { registerInternalRoutes } = await import('../internal-routes.js');

const SCRATCH: string[] = [];
after(async () => {
  for (const d of SCRATCH) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

interface Fixture {
  paperDir: string;
  eprintPath: string;
  sourceDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const paperDir = await mkdtemp(join(tmpdir(), 'openarx-routes-test-'));
  SCRATCH.push(paperDir);
  const staging = await mkdtemp(join(tmpdir(), 'openarx-routes-stage-'));
  SCRATCH.push(staging);
  await writeFile(
    join(staging, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
  );
  await writeFile(join(staging, 'refs.bib'), '@article{a,title={A}}\n');
  await mkdir(join(staging, 'figures'), { recursive: true });
  await writeFile(join(staging, 'figures', 'fig.txt'), 'mock figure\n');
  const eprintPath = join(paperDir, 'eprint');
  await execFileAsync('tar', ['czf', eprintPath, '-C', staging, '.']);
  return { paperDir, eprintPath, sourceDir: join(paperDir, 'source') };
}

function makeDoc(id: string, sourceDir: string): Document {
  return {
    id,
    oarxId: 'oarx-test-1234',
    sourceId: 'test/1234',
    deletedAt: null,
    license: 'CC-BY-4.0',
    sources: { latex: { path: sourceDir, manifest: false, texFiles: 1 } },
    sourceFormat: 'latex',
    rawContentPath: join(sourceDir, '../paper.pdf'),
  } as unknown as Document;
}

interface ServerHandle { port: number; close: () => Promise<void> }

async function startServer(doc: Document | null): Promise<ServerHandle> {
  const app = express();
  const ctx = {
    documentStore: { getById: async () => doc } as unknown as AppContext['documentStore'],
  } as AppContext;
  registerInternalRoutes(app, ctx);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function get(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'X-Internal-Secret': INTERNAL_SECRET },
  });
}

// ── /download?format=latex ───────────────────────────────────────

test('download latex: serves eprint as tar.gz when present', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000001', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/download?format=latex`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    assert.match(r.headers.get('content-disposition') ?? '', /tar\.gz/);
    const buf = Buffer.from(await r.arrayBuffer());
    // gzip magic bytes 0x1F 0x8B
    assert.equal(buf[0], 0x1f);
    assert.equal(buf[1], 0x8b);
  } finally {
    await srv.close();
  }
});

test('download latex: legacy path (eprint absent + source/ present) falls back to zip', async () => {
  const fx = await makeFixture();
  // Simulate legacy state: source/ extracted, eprint removed.
  await mkdir(fx.sourceDir, { recursive: true });
  await execFileAsync('tar', ['xzf', fx.eprintPath, '-C', fx.sourceDir]);
  await rm(fx.eprintPath);

  const doc = makeDoc('00000000-0000-0000-0000-000000000002', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/download?format=latex`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    const buf = Buffer.from(await r.arrayBuffer());
    // zip magic bytes 'PK'
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  } finally {
    await srv.close();
  }
});

test('download latex: 404 when neither eprint nor source/ present', async () => {
  const paperDir = await mkdtemp(join(tmpdir(), 'openarx-routes-empty-'));
  SCRATCH.push(paperDir);
  const sourceDir = join(paperDir, 'source');
  const doc = makeDoc('00000000-0000-0000-0000-000000000003', sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/download?format=latex`);
    assert.equal(r.status, 404);
  } finally {
    await srv.close();
  }
});

// ── /source-file ─────────────────────────────────────────────────

test('source-file: extracts and serves single file from eprint', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000010', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file?path=main.tex`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /x-tex/);
    const text = await r.text();
    assert.match(text, /Hello/);
  } finally {
    await srv.close();
  }
});

test('source-file: 400 on path traversal (..)', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000011', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file?path=..%2F..%2Fetc%2Fpasswd`);
    assert.equal(r.status, 400);
    const body = await r.json() as { error: string };
    assert.equal(body.error, 'path_traversal');
  } finally {
    await srv.close();
  }
});

test('source-file: 400 on absolute path', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000012', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file?path=%2Fetc%2Fpasswd`);
    assert.equal(r.status, 400);
    const body = await r.json() as { error: string };
    assert.equal(body.error, 'path_traversal');
  } finally {
    await srv.close();
  }
});

test('source-file: 404 when file not in archive', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000013', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file?path=does-not-exist.tex`);
    assert.equal(r.status, 404);
  } finally {
    await srv.close();
  }
});

test('source-file: 400 when path query param missing', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000014', fx.sourceDir);
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file`);
    assert.equal(r.status, 400);
  } finally {
    await srv.close();
  }
});

test('source-file: temp dir is cleaned up after response', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000015', fx.sourceDir);
  const srv = await startServer(doc);
  // Snapshot tmp dirs before
  const before = new Set((await readdir(tmpdir())).filter((n) => n.startsWith('openarx-serve-')));
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file?path=main.tex`);
    assert.equal(r.status, 200);
    await r.text(); // consume body so response is fully flushed

    // Give the close/finish handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = new Set((await readdir(tmpdir())).filter((n) => n.startsWith('openarx-serve-')));
    // No new openarx-serve-* dirs should remain. If any are in `after` not
    // in `before`, the cleanup hook didn't fire.
    for (const name of after) {
      assert.ok(before.has(name), `leaked tmp dir: ${name}`);
    }
  } finally {
    await srv.close();
  }
});

test('source-file: 404 when document not found', async () => {
  const srv = await startServer(null);
  try {
    const r = await get(srv.port, `/api/internal/documents/00000000-0000-0000-0000-000000000099/source-file?path=main.tex`);
    assert.equal(r.status, 404);
  } finally {
    await srv.close();
  }
});

test('source-file: 404 when document has no latex source', async () => {
  const fx = await makeFixture();
  const doc = makeDoc('00000000-0000-0000-0000-000000000016', fx.sourceDir);
  // Remove sources.latex from doc
  (doc as unknown as { sources: Record<string, unknown> }).sources = {};
  const srv = await startServer(doc);
  try {
    const r = await get(srv.port, `/api/internal/documents/${doc.id}/source-file?path=main.tex`);
    assert.equal(r.status, 404);
  } finally {
    await srv.close();
  }
});
