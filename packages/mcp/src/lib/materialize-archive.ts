/**
 * materializeArchive — store an uploaded archive the way arxiv ingest stores an
 * eprint (openarx-contracts-w7um §17). The archive is the canonical artifact;
 * the extracted tree is a transient parse artifact, never persisted.
 *
 * Mirrors packages/ingest/src/sources/arxiv-source.ts downloadAndRegister:
 *   - latex / markdown: the upstream tar.gz lives at {dir}/eprint and
 *     `sources.{latex|markdown}.path` is a LAZY pointer to a non-existent
 *     {dir}/source/. parse-strategy.ts extracts eprint→source/ at parse time
 *     and deletes source/ afterwards (LatexStrategy already does this;
 *     MarkdownStrategy gained the same path in w7um).
 *   - pdf: the file lives at {dir}/paper.pdf and `sources.pdf.path` points at it.
 *
 * For portal we receive a ZIP (or, via a single-file content_ref, a raw
 * pdf/tex/md). A ZIP is transcoded to a gzip-tar `eprint` so the existing
 * lazy-extract path (`tar xzf eprint`) works unchanged; a raw pdf is copied to
 * paper.pdf; a raw single tex/md is wrapped as a one-file eprint.
 *
 * Nothing here is persisted but `eprint` (or `paper.pdf`): the transient
 * extraction dir is removed before returning, so the document directory mirrors
 * an arxiv directory exactly.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DocumentSources } from '@openarx/types';
import {
  ARCHIVE_LIMITS,
  ArchiveIntakeError,
  buildAttachments,
  checkFormatMatch,
  extractArchive,
  resolveMainFile,
  type ExtractedFile,
} from '../profiles/pub/archive-intake.js';
import { detectKind } from './file-magic.js';

const execFileAsync = promisify(execFile);

const EXT_BY_FORMAT: Record<'latex' | 'markdown' | 'pdf', string> = {
  latex: '.tex', markdown: '.md', pdf: '.pdf',
};

export interface MaterializedArchive {
  /** documents.sources — lazy `source/` pointer for archives, direct path for pdf. */
  sources: DocumentSources;
  /** documents.raw_content_path — paper.pdf, or the (lazy) main file in source/. */
  rawContentPath: string;
  /** Archive-relative primary file (rootTex/rootMd, or paper.pdf). */
  mainFile: string;
  /** Non-main entries, for content_source.attachments display. */
  attachments: Array<{ filename: string; size: number; type: string }>;
}

export interface MaterializeArchiveOptions {
  /** Raw uploaded archive on disk: a ZIP, or a single pdf/tex/md file. */
  archivePath: string;
  /** Directory to materialize into (created if missing). Becomes the document's
   *  canonical storage dir; `sources` paths are built against it. */
  canonicalDir: string;
  contentFormat: 'latex' | 'markdown' | 'pdf';
  /** Explicit main file within a ZIP; auto-inferred when omitted. */
  mainFile?: string;
}

/** Atomic single-file write within canonicalDir: write to .partial then rename. */
async function writeAtomic(targetPath: string, bytes: Buffer): Promise<void> {
  const tmp = `${targetPath}.partial-${randomUUID()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, targetPath);
}

export async function materializeArchive(opts: MaterializeArchiveOptions): Promise<MaterializedArchive> {
  const { archivePath, canonicalDir, contentFormat, mainFile } = opts;

  const buf = await readFile(archivePath);
  if (buf.length > ARCHIVE_LIMITS.decodedMax) {
    throw new ArchiveIntakeError(
      'archive_too_large_decoded',
      `Archive is ${buf.length} bytes; limit is ${ARCHIVE_LIMITS.decodedMax}`,
      { decoded_bytes: buf.length, limit: ARCHIVE_LIMITS.decodedMax },
    );
  }
  const isZip = detectKind(buf.subarray(0, 16)) === 'zip';

  await mkdir(canonicalDir, { recursive: true });

  // ── PDF: store paper.pdf, point sources.pdf at it ──
  if (contentFormat === 'pdf') {
    let pdfBytes: Buffer;
    let resolvedMain = 'paper.pdf';
    if (isZip) {
      const extractDir = join(canonicalDir, `.extract-${randomUUID()}`);
      try {
        const files = await extractArchive(buf, extractDir);
        const main = resolveMainFile(files, mainFile);
        checkFormatMatch(main, 'pdf');
        resolvedMain = main;
        pdfBytes = await readFile(join(extractDir, main));
      } finally {
        await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      pdfBytes = buf;
    }
    if (detectKind(pdfBytes.subarray(0, 16)) !== 'pdf') {
      throw new ArchiveIntakeError(
        'archive_main_file_format_mismatch',
        'content_format is pdf but the primary file is not a PDF (%PDF- signature)',
        { expected_format: 'pdf' },
      );
    }
    const paperPath = join(canonicalDir, 'paper.pdf');
    await writeAtomic(paperPath, pdfBytes);
    return {
      sources: { pdf: { path: paperPath, size: pdfBytes.length } },
      rawContentPath: paperPath,
      mainFile: resolvedMain,
      attachments: [],
    };
  }

  // ── LaTeX / Markdown: transcode to a gzip-tar `eprint`, leave source/ lazy ──
  const extractDir = join(canonicalDir, `.extract-${randomUUID()}`);
  let files: ExtractedFile[];
  let main: string;
  try {
    if (isZip) {
      files = await extractArchive(buf, extractDir);
      main = resolveMainFile(files, mainFile);
      checkFormatMatch(main, contentFormat);
    } else {
      // Single raw tex/md uploaded directly (content_ref) — wrap as a one-file
      // archive named main.<ext> so the eprint/source layout is uniform.
      main = `main${EXT_BY_FORMAT[contentFormat]}`;
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(extractDir, main), buf);
      files = [{ filename: main, size: buf.length }];
    }

    // gzip-tar the extracted tree → {canonicalDir}/eprint (atomic via .partial).
    // `-C extractDir .` archives the entry paths at the top level, so a later
    // `tar xzf eprint -C source` yields source/<main> exactly where the parser
    // expects it.
    const eprintTmp = join(canonicalDir, `eprint.partial-${randomUUID()}`);
    await execFileAsync('tar', ['czf', eprintTmp, '-C', extractDir, '.']);
    await rename(eprintTmp, join(canonicalDir, 'eprint'));
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const sourceDir = join(canonicalDir, 'source'); // lazy pointer — not created
  const rawContentPath = join(sourceDir, main);
  const attachments = buildAttachments(files, main);

  if (contentFormat === 'latex') {
    const texFiles = files.filter((f) => /\.tex$/i.test(f.filename)).length;
    return {
      sources: { latex: { path: sourceDir, rootTex: main, manifest: false, texFiles } },
      rawContentPath,
      mainFile: main,
      attachments,
    };
  }
  return {
    sources: { markdown: { path: sourceDir, rootMd: main } },
    rawContentPath,
    mainFile: main,
    attachments,
  };
}

/** True iff `dir` exists and is a directory — used by the endpoint to decide
 *  whether a client-supplied storage_path is the legacy extracted-tree shape. */
export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
