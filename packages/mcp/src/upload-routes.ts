/**
 * PUT /api/upload/{file_id} — presigned binary upload endpoint
 * (openarx-contracts-xuqi). NOT an MCP tool and NOT mounted under the
 * X-Internal-Secret router: the URL is self-authenticating via the HMAC
 * signature minted by create_upload_url, so an agent sandbox can
 * `curl --upload-file` straight to it.
 *
 * It is registered before the Bearer-auth middleware short-circuits (the auth
 * middleware skips /api/upload) and on a path with no body parser, so the raw
 * request stream reaches the handler intact and is streamed to disk with a
 * hard size cap. Magic bytes are checked on the first chunk; sha256 is computed
 * for the integrity field in the response.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';
import type { AppContext } from './context.js';
import { verifyUploadSignature } from './lib/upload-signing.js';
import { checkUploadMagic } from './lib/file-magic.js';
import { uploadDir, uploadFilePath } from './lib/upload-paths.js';

/** Binary ceiling (matches ARCHIVE_LIMITS.decodedMax). Env-overridable so
 *  tests can drive the 413 path without a real 50 MB body. */
export const UPLOAD_MAX_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES ?? String(50 * 1024 * 1024), 10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown inside the streaming Transform to abort the pipeline with a status. */
class UploadError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'UploadError';
  }
}

export function registerUploadRoutes(app: Express, ctx: AppContext): void {
  app.put('/api/upload/:file_id', (req: Request, res: Response) => {
    void handleUpload(req, res, ctx);
  });
}

interface PendingRow {
  user_id: string;
  filled_at: Date | null;
  expected_content_type: string | null;
}

async function handleUpload(req: Request, res: Response, ctx: AppContext): Promise<void> {
  const fileId = String(req.params.file_id ?? '');
  const expiresUnix = Number(req.query.expires);
  const signature = req.query.signature;

  // ── Self-authentication: signature + expiry (both → 401, no leak of which) ──
  if (!UUID_RE.test(fileId)) {
    res.status(400).json({ ok: false, error: 'bad_file_id' });
    return;
  }
  if (typeof signature !== 'string' || !Number.isInteger(expiresUnix)) {
    res.status(400).json({ ok: false, error: 'bad_request', message: 'expires and signature query params are required' });
    return;
  }
  if (!verifyUploadSignature(fileId, expiresUnix, signature)) {
    res.status(401).json({ ok: false, error: 'invalid_signature' });
    return;
  }
  if (expiresUnix * 1000 <= Date.now()) {
    res.status(401).json({ ok: false, error: 'expired' });
    return;
  }

  // ── Pending-row lookup ──
  const { rows } = await ctx.pool.query<PendingRow>(
    'SELECT user_id, filled_at, expected_content_type FROM portal_pending_uploads WHERE file_id = $1::uuid',
    [fileId],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ ok: false, error: 'unknown_file_id' });
    return;
  }
  if (row.filled_at != null) {
    res.status(409).json({ ok: false, error: 'already_uploaded' });
    return;
  }
  if (!UUID_RE.test(row.user_id)) {
    res.status(500).json({ ok: false, error: 'corrupt_row' });
    return;
  }

  // ── Stream body → disk with magic check, cap and sha256 ──
  const dest = uploadFilePath(row.user_id, fileId);
  await mkdir(uploadDir(row.user_id), { recursive: true });

  const hash = createHash('sha256');
  let bytes = 0;
  let firstChunkChecked = false;
  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        if (!firstChunkChecked) {
          firstChunkChecked = true;
          const reason = checkUploadMagic(chunk.subarray(0, 16), row.expected_content_type);
          if (reason) throw new UploadError(400, 'magic_byte_mismatch', reason);
        }
        bytes += chunk.length;
        if (bytes > UPLOAD_MAX_BYTES) throw new UploadError(413, 'too_large', `upload exceeds ${UPLOAD_MAX_BYTES} bytes`);
        hash.update(chunk);
        cb(null, chunk);
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  try {
    await pipeline(req, gate, createWriteStream(dest));
  } catch (err) {
    await rm(dest, { force: true }).catch(() => { /* best effort */ });
    if (err instanceof UploadError) {
      res.status(err.status).json({
        ok: false,
        error: err.code,
        message: err.message,
        ...(err.code === 'too_large' ? { limit: UPLOAD_MAX_BYTES } : {}),
      });
      return;
    }
    res.status(400).json({ ok: false, error: 'stream_error', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  // ── Race-safe fill: only the first PUT to flip filled_at wins ──
  const upd = await ctx.pool.query(
    'UPDATE portal_pending_uploads SET filled_at = now(), size_bytes = $1 WHERE file_id = $2::uuid AND filled_at IS NULL',
    [bytes, fileId],
  );
  if (upd.rowCount === 0) {
    await rm(dest, { force: true }).catch(() => { /* best effort */ });
    res.status(409).json({ ok: false, error: 'already_uploaded' });
    return;
  }

  res.status(200).json({ ok: true, file_id: fileId, size_bytes: bytes, sha256: hash.digest('hex') });
}
