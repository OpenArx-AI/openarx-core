/**
 * ZIP archive intake for submit_document / create_new_version
 * (openarx-contracts-nie7). One mechanism for three publish use cases:
 * single archived PDF, markdown + figures, multifile LaTeX.
 *
 * The agent uploads `content_archive_base64`; this module decodes,
 * validates and extracts it into a caller-provided directory. The MCP
 * handler then composes the Scenario B content_source payload
 * (contracts/ingest_document_api.md) — the agent never sees Scenario B.
 *
 * Defense layers (in order, cheapest first):
 * 1. strict base64 alphabet check                → invalid_base64
 * 2. magic bytes: only PK\x03\x04 accepted (v1)  → archive_not_zip
 * 3. decoded size cap (default 50 MB)            → archive_too_large_decoded
 * 4. per-entry path validation: no '..' segment, no absolute paths,
 *    no symlink entries                          → archive_path_traversal /
 *                                                  archive_symlink_entry
 * 5. UNCOMPRESSED running total cap while inflating (default 200 MB) —
 *    counts ACTUAL inflated bytes, not the header's declared size, so a
 *    lying zip bomb is caught mid-stream          → archive_uncompressed_too_large
 *
 * Errors are structured (ArchiveIntakeError) so the handler can return the
 * same envelope shape for dry_run and real submissions.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, posix, extname, basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export const ARCHIVE_LIMITS = {
  /** Base64-encoded ceiling (zod .max on the field): ~67 MB ≈ 50 MB binary. */
  encodedMax: 67_000_000,
  /** Decoded (binary) ceiling. */
  decodedMax: 50 * 1024 * 1024,
  /** Total uncompressed ceiling across all entries (zip-bomb defense). */
  uncompressedMax: 200 * 1024 * 1024,
} as const;

export type ArchiveErrorCode =
  | 'invalid_base64'
  | 'archive_not_zip'
  | 'archive_too_large_decoded'
  | 'archive_uncompressed_too_large'
  | 'archive_path_traversal'
  | 'archive_symlink_entry'
  | 'archive_main_file_required'
  | 'archive_main_file_not_found'
  | 'archive_main_file_format_mismatch'
  | 'archive_extract_failed';

export class ArchiveIntakeError extends Error {
  constructor(
    public readonly code: ArchiveErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ArchiveIntakeError';
  }
}

export interface ExtractedFile {
  /** Archive-relative path, forward slashes. */
  filename: string;
  /** Actual uncompressed size in bytes. */
  size: number;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Step 1–3: strict-decode the base64 payload and check magic + size. */
export function decodeArchive(
  base64: string,
  limits: { decodedMax: number } = ARCHIVE_LIMITS,
): Buffer {
  const cleaned = base64.replace(/\s+/g, '');
  if (cleaned.length === 0 || !BASE64_RE.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new ArchiveIntakeError('invalid_base64', 'content_archive_base64 is not valid base64');
  }
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new ArchiveIntakeError('archive_not_zip', 'Archive must be a ZIP file (PK\\x03\\x04 signature). For a single PDF, zip it first.');
  }
  if (buf.length > limits.decodedMax) {
    throw new ArchiveIntakeError('archive_too_large_decoded', `Decoded archive is ${buf.length} bytes; limit is ${limits.decodedMax}`, { decoded_bytes: buf.length, limit: limits.decodedMax });
  }
  return buf;
}

/** True when the zip entry path tries to escape the extraction root. */
export function isUnsafeEntryPath(entryName: string): boolean {
  if (entryName.startsWith('/') || /^[A-Za-z]:[/\\]/.test(entryName)) return true;
  const segments = entryName.split(/[/\\]/);
  return segments.some((s) => s === '..');
}

/** Unix mode lives in the high 16 bits of external attributes; symlinks are S_IFLNK. */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
}

/**
 * Steps 4–5: extract the validated buffer into destDir, enforcing per-entry
 * safety and the ACTUAL-uncompressed-bytes cap while inflating.
 */
export function extractArchive(
  buf: Buffer,
  destDir: string,
  limits: { uncompressedMax: number } = ARCHIVE_LIMITS,
): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new ArchiveIntakeError('archive_extract_failed', `Cannot read ZIP: ${err?.message ?? 'unknown error'}`));
        return;
      }

      const files: ExtractedFile[] = [];
      let totalUncompressed = 0;
      let settled = false;
      const fail = (e: ArchiveIntakeError): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(e);
      };

      zipfile.on('error', (e: Error) => {
        // yauzl itself rejects entries with relative/absolute escape paths
        // before our per-entry check sees them — keep the honest error code.
        if (/invalid relative path|absolute path/i.test(e.message)) {
          fail(new ArchiveIntakeError('archive_path_traversal', `Archive entry has an unsafe path: ${e.message}`));
          return;
        }
        fail(new ArchiveIntakeError('archive_extract_failed', `ZIP read error: ${e.message}`));
      });

      zipfile.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;

        if (isUnsafeEntryPath(name)) {
          fail(new ArchiveIntakeError('archive_path_traversal', `Archive entry has an unsafe path: ${name}`, { entry: name }));
          return;
        }
        if (isSymlinkEntry(entry)) {
          fail(new ArchiveIntakeError('archive_symlink_entry', `Archive contains a symlink entry: ${name}`, { entry: name }));
          return;
        }
        if (name.endsWith('/')) { // directory entry
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(new ArchiveIntakeError('archive_extract_failed', `Cannot read entry ${name}: ${streamErr?.message ?? 'unknown'}`));
            return;
          }
          let entryBytes = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              entryBytes += chunk.length;
              totalUncompressed += chunk.length;
              if (totalUncompressed > limits.uncompressedMax) {
                cb(new ArchiveIntakeError('archive_uncompressed_too_large', `Uncompressed contents exceed ${limits.uncompressedMax} bytes`, { limit: limits.uncompressedMax }));
                return;
              }
              cb(null, chunk);
            },
          });

          const target = join(destDir, name);
          void (async () => {
            try {
              await mkdir(dirname(target), { recursive: true });
              await pipeline(readStream, counter, createWriteStream(target));
              files.push({ filename: posix.normalize(name.split('\\').join('/')), size: entryBytes });
              zipfile.readEntry();
            } catch (e) {
              fail(e instanceof ArchiveIntakeError
                ? e
                : new ArchiveIntakeError('archive_extract_failed', `Failed extracting ${name}: ${e instanceof Error ? e.message : String(e)}`));
            }
          })();
        });
      });

      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });

      zipfile.readEntry();
    });
  });
}

/**
 * List entries (name + declared uncompressed size) WITHOUT writing anything to
 * disk. Used by the MCP tool layer (openarx-contracts-w7um) to resolve the
 * main_file, check the format and build the dry-run preview cheaply — the raw
 * archive is materialized once, later, by the publish endpoint. Per-entry path
 * and symlink safety are still enforced; the zip-bomb running-total cap is not
 * (nothing is inflated here — the real extract in materializeArchive enforces
 * it). Sizes come from the central-directory header, which is fine for display
 * and selection but is NOT trusted for the inflation cap.
 */
export function listArchiveEntries(buf: Buffer): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new ArchiveIntakeError('archive_extract_failed', `Cannot read ZIP: ${err?.message ?? 'unknown error'}`));
        return;
      }
      const files: ExtractedFile[] = [];
      let settled = false;
      const fail = (e: ArchiveIntakeError): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(e);
      };
      zipfile.on('error', (e: Error) => {
        if (/invalid relative path|absolute path/i.test(e.message)) {
          fail(new ArchiveIntakeError('archive_path_traversal', `Archive entry has an unsafe path: ${e.message}`));
          return;
        }
        fail(new ArchiveIntakeError('archive_extract_failed', `ZIP read error: ${e.message}`));
      });
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (isUnsafeEntryPath(name)) {
          fail(new ArchiveIntakeError('archive_path_traversal', `Archive entry has an unsafe path: ${name}`, { entry: name }));
          return;
        }
        if (isSymlinkEntry(entry)) {
          fail(new ArchiveIntakeError('archive_symlink_entry', `Archive contains a symlink entry: ${name}`, { entry: name }));
          return;
        }
        if (!name.endsWith('/')) {
          files.push({ filename: posix.normalize(name.split('\\').join('/')), size: entry.uncompressedSize });
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });
      zipfile.readEntry();
    });
  });
}

const MAIN_FILE_RE = /\.(pdf|tex|md|markdown)$/i;

/**
 * Step 6: resolve which file is the primary content. Explicit main_file
 * must exist in the archive; otherwise exactly one root-level candidate
 * with a recognized extension is auto-inferred.
 */
export function resolveMainFile(files: ExtractedFile[], mainFile?: string): string {
  if (mainFile) {
    const normalized = posix.normalize(mainFile.split('\\').join('/'));
    if (isUnsafeEntryPath(normalized)) {
      throw new ArchiveIntakeError('archive_path_traversal', `main_file has an unsafe path: ${mainFile}`);
    }
    const found = files.find((f) => f.filename === normalized);
    if (!found) {
      throw new ArchiveIntakeError('archive_main_file_not_found', `main_file "${mainFile}" not found in archive`, { available: files.map((f) => f.filename).slice(0, 50) });
    }
    return found.filename;
  }

  const rootCandidates = files.filter((f) => !f.filename.includes('/') && MAIN_FILE_RE.test(f.filename));
  if (rootCandidates.length === 1) return rootCandidates[0].filename;
  throw new ArchiveIntakeError(
    'archive_main_file_required',
    rootCandidates.length === 0
      ? 'No .pdf/.tex/.md file found at the archive root — pass main_file explicitly'
      : `Multiple candidate files at the archive root — pass main_file explicitly`,
    { candidates: rootCandidates.map((f) => f.filename) },
  );
}

const EXT_TO_FORMAT: Record<string, 'pdf' | 'latex' | 'markdown'> = {
  '.pdf': 'pdf',
  '.tex': 'latex',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

/** Step 7: main_file extension must agree with the declared content_format. */
export function checkFormatMatch(mainFile: string, contentFormat: 'pdf' | 'latex' | 'markdown'): void {
  const ext = extname(mainFile).toLowerCase();
  const derived = EXT_TO_FORMAT[ext];
  if (derived !== contentFormat) {
    throw new ArchiveIntakeError(
      'archive_main_file_format_mismatch',
      `main_file "${basename(mainFile)}" (${ext || 'no extension'}) does not match content_format "${contentFormat}"`,
      { main_file: mainFile, extension: ext, expected_format: contentFormat, derived_format: derived ?? null },
    );
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.tex': 'application/x-tex', '.md': 'text/markdown',
  '.markdown': 'text/markdown', '.bib': 'application/x-bibtex', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.eps': 'application/postscript', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.sty': 'application/x-tex', '.cls': 'application/x-tex',
};

export function guessMime(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Scenario B attachments list (everything except main_file). */
export function buildAttachments(files: ExtractedFile[], mainFile: string): Array<{ filename: string; size: number; type: string }> {
  return files
    .filter((f) => f.filename !== mainFile)
    .map((f) => ({ filename: f.filename, size: f.size, type: guessMime(f.filename) }));
}

/** Sanity helper for callers: assert an extracted file really landed on disk. */
export async function assertExtractedFile(destDir: string, relPath: string): Promise<void> {
  const st = await stat(join(destDir, relPath));
  if (!st.isFile()) {
    throw new ArchiveIntakeError('archive_main_file_not_found', `Extracted main_file is not a regular file: ${relPath}`);
  }
}
