/**
 * Regression test for openarx-y9ef — the run busy-claim must be SYNCHRONOUS.
 *
 * Root cause of the 2026-06-18 duplicate-run incident ($3146): ingest() checked
 * `isRunning` and then `await`ed before setting `currentRunId`, so two commands
 * arriving within that await window both passed the guard and started runs. The
 * fix claims a synchronous `starting` latch the instant a run begins — before
 * any await — so a concurrent second call is rejected with "Already running".
 *
 * The @openarx/api `query` is mocked to PARK the first call's INSERT await open,
 * reproducing the race window deterministically; the second call must reject
 * while the first is still parked.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Never resolves — parks the first call's INSERT await inside the latch window.
const insertGate = new Promise<void>(() => {});

// Pass the real @openarx/api through (stores/pool/etc. used by the transitive
// pipeline import graph) and override ONLY `query` to park the INSERT await.
const realApi = await import('@openarx/api');
mock.module('@openarx/api', {
  namedExports: {
    ...realApi,
    query: async () => {
      await insertGate; // park here → keeps the first ingest() inside the latch window
      return { rows: [], rowCount: 1 };
    },
  },
});

const { RunnerService } = await import('./RunnerService.js');

const DL_FIRST = [
  1,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  true,
] as const;

test('openarx-y9ef: concurrent ingest() rejected — claim is synchronous', async () => {
  const svc = new RunnerService();

  // First call parks at the INSERT await (insertGate still pending).
  const p1 = svc.ingest(...DL_FIRST);
  p1.catch(() => {}); // its detached worker runs without init() — ignore.

  // The lock must be held SYNCHRONOUSLY, before the INSERT resolves.
  assert.equal(
    svc.isRunning,
    true,
    'run must be claimed synchronously, before the INSERT await resolves',
  );

  // A second overlapping call must be rejected, not start a duplicate run.
  await assert.rejects(svc.ingest(...DL_FIRST), /Already running/);

  // Leave the first call parked at the gate — releasing it would fire the
  // detached worker (which needs a DB). The synchronous claim is already proven.
});

test('openarx-y9ef: registryUpdate is rejected while a run is in flight', async () => {
  const svc = new RunnerService();
  const p1 = svc.ingest(...DL_FIRST);
  p1.catch(() => {});
  assert.equal(svc.isRunning, true);
  await assert.rejects(svc.registryUpdate({ dateFrom: '2024-01-01' }), /Already running/);
});
