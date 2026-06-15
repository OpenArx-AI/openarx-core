/**
 * HMAC-signed presigned upload URLs (openarx-contracts-xuqi).
 *
 * create_upload_url signs (file_id, expires_unix) with CORE_INTERNAL_SECRET;
 * PUT /api/upload/{file_id} re-derives the signature and compares it in
 * constant time. The signature is the ONLY authentication on the PUT endpoint
 * — it is mounted outside the Bearer-auth and X-Internal-Secret middleware —
 * so the shared secret never leaves the server and the URL is safe to hand to
 * an untrusted agent sandbox for a `curl --upload-file`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Short-lived: the agent should PUT promptly after requesting the URL (§1). */
export const UPLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Read the secret lazily so a process picks up rotations and tests can set
 *  CORE_INTERNAL_SECRET before the first call without a module reload. */
function secret(): string {
  return process.env.CORE_INTERNAL_SECRET ?? '';
}

/** Hex HMAC-SHA256 over `${file_id}:${expires_unix}`. */
export function signUpload(fileId: string, expiresUnix: number): string {
  return createHmac('sha256', secret()).update(`${fileId}:${expiresUnix}`).digest('hex');
}

/**
 * Constant-time signature check. Returns false (never throws) on any
 * format/length mismatch so the caller can map every failure to one opaque
 * 401 without leaking which check failed.
 */
export function verifyUploadSignature(fileId: string, expiresUnix: number, signature: string): boolean {
  if (!Number.isInteger(expiresUnix) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signUpload(fileId, expiresUnix), 'hex');
  const got = Buffer.from(signature, 'hex');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
