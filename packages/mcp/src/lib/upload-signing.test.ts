/**
 * openarx-contracts-xuqi: presigned-upload HMAC signing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CORE_INTERNAL_SECRET = 'test-secret-for-upload-signing';
const { signUpload, verifyUploadSignature, UPLOAD_TTL_MS } = await import('./upload-signing.js');

const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXPIRES = 1_900_000_000;

test('sign → verify roundtrip succeeds', () => {
  const sig = signUpload(FILE_ID, EXPIRES);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyUploadSignature(FILE_ID, EXPIRES, sig), true);
});

test('tampered signature is rejected', () => {
  const sig = signUpload(FILE_ID, EXPIRES);
  const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  assert.equal(verifyUploadSignature(FILE_ID, EXPIRES, flipped), false);
});

test('signature does not validate for a different file_id or expiry', () => {
  const sig = signUpload(FILE_ID, EXPIRES);
  assert.equal(verifyUploadSignature('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', EXPIRES, sig), false);
  assert.equal(verifyUploadSignature(FILE_ID, EXPIRES + 1, sig), false);
});

test('malformed signatures (non-hex / wrong length / empty) are rejected, not thrown', () => {
  for (const bad of ['', 'nothex', 'ab', signUpload(FILE_ID, EXPIRES).slice(0, 63)]) {
    assert.equal(verifyUploadSignature(FILE_ID, EXPIRES, bad), false);
  }
});

test('non-integer expiry is rejected', () => {
  const sig = signUpload(FILE_ID, EXPIRES);
  assert.equal(verifyUploadSignature(FILE_ID, Number.NaN, sig), false);
});

test('TTL is 10 minutes', () => {
  assert.equal(UPLOAD_TTL_MS, 10 * 60 * 1000);
});
