/**
 * openarx-contracts-amc7: GET /api/internal/user-documents.
 * Pure helpers + in-process handler over a stubbed pool (no Postgres).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AppContext } from './context.js';
import {
  encodeCursor, decodeCursor, mapSpamVerdict, mapReviewStatus, handleUserDocuments,
} from './user-documents.js';

const UID = '3b832835-e512-4f75-9160-f20f608413f9';

// ── pure helpers ──────────────────────────────────────────────

test('cursor encode/decode roundtrip', () => {
  const id = 'aaaaaaaa-0000-0000-0000-000000000000';
  const c = encodeCursor(new Date('2026-06-14T10:00:00.000Z'), id);
  assert.deepEqual(decodeCursor(c), { updatedAt: '2026-06-14T10:00:00.000Z', id });
});

test('decodeCursor returns null for malformed input', () => {
  assert.equal(decodeCursor('!!!not-base64!!!'), null);
  assert.equal(decodeCursor(Buffer.from('noseparator', 'utf8').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('2026-01-01T00:00:00Z|not-a-uuid', 'utf8').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('not-a-date|aaaaaaaa-0000-0000-0000-000000000000', 'utf8').toString('base64url')), null);
});

test('mapSpamVerdict maps Core vocab → contract enum', () => {
  assert.equal(mapSpamVerdict('pass'), 'pass');
  assert.equal(mapSpamVerdict('borderline'), 'review');
  assert.equal(mapSpamVerdict('reject'), 'rejected');
  assert.equal(mapSpamVerdict(null), null);
  assert.equal(mapSpamVerdict(undefined), null);
});

test('mapReviewStatus maps Core vocab → contract enum (running→pending)', () => {
  assert.equal(mapReviewStatus('complete'), 'complete');
  assert.equal(mapReviewStatus('failed'), 'failed');
  assert.equal(mapReviewStatus('pending'), 'pending');
  assert.equal(mapReviewStatus('running'), 'pending');
  assert.equal(mapReviewStatus(null), null);
});

// ── handler over a stubbed pool ───────────────────────────────

function docRow(idChar: string, updatedISO: string): Record<string, unknown> {
  return {
    id: `${idChar.repeat(8)}-0000-0000-0000-000000000000`,
    oarx_id: 'oarx-1234567890abcdef',
    title: 'A Paper',
    authors: [{ name: 'Ada L.' }],
    source_format: 'markdown',
    status: 'ready',
    indexing_tier: 'full',
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date(updatedISO),
    license: 'cc-by-4.0',
    spam_verdict: 'borderline',
    review_status: 'running',
  };
}

interface Harness { port: number; calls: { sql: string; params: unknown[] }[]; close: () => Promise<void> }

async function start(queryImpl: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>): Promise<Harness> {
  const calls: { sql: string; params: unknown[] }[] = [];
  const ctx = {
    pool: {
      query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return queryImpl(sql, params); },
    },
  } as unknown as AppContext;
  const app = express();
  app.get('/api/internal/user-documents', (req, res) => { void handleUserDocuments(req, res, ctx); });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, calls, close: () => new Promise((r) => server.close(() => r())) };
}

const get = (port: number, qs: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/api/internal/user-documents${qs}`);

test('missing user_id → 400 user_required (acceptance 3)', async () => {
  const h = await start(async () => ({ rows: [] }));
  const r = await get(h.port, '');
  const j = await r.json() as Record<string, unknown>;
  assert.equal(r.status, 400);
  assert.equal(j.error, 'user_required');
  await h.close();
});

test('malformed user_id → 400 user_required', async () => {
  const h = await start(async () => ({ rows: [] }));
  const r = await get(h.port, '?user_id=not-a-uuid');
  assert.equal(r.status, 400);
  await h.close();
});

test('unknown user → 200 with empty docs (acceptance 2)', async () => {
  const h = await start(async () => ({ rows: [] }));
  const r = await get(h.port, `?user_id=${UID}`);
  const j = await r.json() as Record<string, unknown>;
  assert.equal(r.status, 200);
  assert.deepEqual(j.docs, []);
  assert.equal(j.next_cursor, null);
  await h.close();
});

test('returns mapped DocumentSummary; next_cursor null when <= limit', async () => {
  const h = await start(async () => ({ rows: [docRow('a', '2026-06-14T10:00:00.000Z')] }));
  const r = await get(h.port, `?user_id=${UID}`);
  const j = await r.json() as { docs: Record<string, unknown>[]; next_cursor: string | null };
  assert.equal(r.status, 200);
  assert.equal(j.docs.length, 1);
  assert.equal(j.next_cursor, null);
  const d = j.docs[0];
  assert.equal(d.core_document_id, 'aaaaaaaa-0000-0000-0000-000000000000');
  assert.equal(d.format, 'markdown');
  assert.equal(d.spam_verdict, 'review');      // borderline → review
  assert.equal(d.review_status, 'pending');    // running → pending
  assert.equal(d.updated_at, '2026-06-14T10:00:00.000Z');
  await h.close();
});

test('pagination: limit+1 rows → next_cursor set, docs trimmed to limit (acceptance 4)', async () => {
  // limit=2 → handler asks for 3; stub returns 3 → 2 returned + cursor
  const rows = [
    docRow('a', '2026-06-14T12:00:00.000Z'),
    docRow('b', '2026-06-14T11:00:00.000Z'),
    docRow('c', '2026-06-14T10:00:00.000Z'),
  ];
  const h = await start(async (sql, params) => {
    assert.equal(params[params.length - 1], 3); // LIMIT bind = limit+1
    return { rows };
  });
  const r = await get(h.port, `?user_id=${UID}&limit=2`);
  const j = await r.json() as { docs: unknown[]; next_cursor: string | null };
  assert.equal(j.docs.length, 2);
  assert.ok(j.next_cursor);
  // cursor points at the last RETURNED row (b), so the next page starts after it
  assert.deepEqual(decodeCursor(j.next_cursor!), {
    updatedAt: '2026-06-14T11:00:00.000Z', id: 'bbbbbbbb-0000-0000-0000-000000000000',
  });
  await h.close();
});

test('since filter is passed to the query (acceptance 5)', async () => {
  const h = await start(async () => ({ rows: [] }));
  await get(h.port, `?user_id=${UID}&since=2026-06-10T00:00:00.000Z`);
  const call = h.calls[0];
  assert.match(call.sql, /updated_at >= /);
  assert.ok(call.params.includes('2026-06-10T00:00:00.000Z'));
  await h.close();
});

test('limit is clamped to max 200', async () => {
  const h = await start(async () => ({ rows: [] }));
  await get(h.port, `?user_id=${UID}&limit=9999`);
  assert.equal(h.calls[0].params[h.calls[0].params.length - 1], 201); // 200 + 1
  await h.close();
});

test('DB error → 503 user_documents_unavailable, not silent empty (acceptance 6)', async () => {
  const h = await start(async () => { throw new Error('connection terminated'); });
  const r = await get(h.port, `?user_id=${UID}`);
  const j = await r.json() as Record<string, unknown>;
  assert.equal(r.status, 503);
  assert.equal(j.error, 'user_documents_unavailable');
  await h.close();
});
