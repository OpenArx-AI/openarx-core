/**
 * isPermanentDownloadFailure (openarx-gf2h) — permanent 404-class download
 * failures must not feed the consecutive_day_failures auto-stop counter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPermanentDownloadFailure } from './RunnerService.js';

test('permanent: 4xx download statuses (the false-trip class)', () => {
  assert.equal(isPermanentDownloadFailure('Download failed: 404 https://arxiv.org/pdf/1304.3846'), true);
  assert.equal(isPermanentDownloadFailure('Download failed: 403 https://arxiv.org/pdf/1304.0001'), true);
  assert.equal(isPermanentDownloadFailure('Download failed: 410 https://arxiv.org/pdf/1304.0002'), true);
});

test('transient: timeouts, rate limits, 5xx, network errors keep counting', () => {
  assert.equal(isPermanentDownloadFailure('Download failed: 408 https://arxiv.org/pdf/x'), false);
  assert.equal(isPermanentDownloadFailure('Download failed: 429 https://arxiv.org/pdf/x'), false);
  assert.equal(isPermanentDownloadFailure('Download failed: 500 https://arxiv.org/pdf/x'), false);
  assert.equal(isPermanentDownloadFailure('Download failed: 503 https://arxiv.org/pdf/x'), false);
  assert.equal(isPermanentDownloadFailure('Download failed: no response https://arxiv.org/pdf/x'), false);
  assert.equal(isPermanentDownloadFailure('fetch failed'), false); // e5199fcd network blip
  assert.equal(isPermanentDownloadFailure('ECONNREFUSED 127.0.0.1:5433'), false);
});
