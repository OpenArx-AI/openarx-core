/**
 * openarx-contracts-w7um D4: materializeArchive — store uploads the arxiv way
 * (eprint canonical, source/ lazy). The eprint round-trip asserts the exact
 * contract parse-strategy relies on: `tar xzf eprint -C source` yields
 * source/<rootTex|rootMd> with the original bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import archiver from 'archiver';
import { materializeArchive } from './materialize-archive.js';
import { ArchiveIntakeError } from '../profiles/pub/archive-intake.js';

const execFileAsync = promisify(execFile);

function makeZip(build: (a: archiver.Archiver) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const a = archiver('zip');
    const chunks: Buffer[] = [];
    a.on('data', (c: Buffer) => chunks.push(c));
    a.on('end', () => resolve(Buffer.concat(chunks)));
    a.on('error', reject);
    build(a);
    void a.finalize();
  });
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'oarx-mat-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write `bytes` to a fresh file under `dir` and return its path. */
async function stage(dir: string, name: string, bytes: Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, bytes);
  return p;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

test('latex ZIP → eprint canonical, source/ lazy, sources point at source/', async () => {
  await withTmp(async (dir) => {
    const zip = await makeZip((a) => {
      a.append('\\documentclass{article}\\begin{document}hi\\end{document}', { name: 'main.tex' });
      a.append('\\section{X}', { name: 'sec.tex' });
      a.append(Buffer.from([0x89, 0x50]), { name: 'figures/f.png' });
    });
    const archivePath = await stage(dir, 'upload.zip', zip);
    const canonicalDir = join(dir, 'doc');

    // two root .tex → main_file must be explicit
    const out = await materializeArchive({ archivePath, canonicalDir, contentFormat: 'latex', mainFile: 'main.tex' });

    assert.equal(out.mainFile, 'main.tex');
    assert.deepEqual(out.sources.latex, {
      path: join(canonicalDir, 'source'), rootTex: 'main.tex', manifest: false, texFiles: 2,
    });
    assert.equal(out.rawContentPath, join(canonicalDir, 'source', 'main.tex'));
    // eprint exists; source/ does NOT (lazy); no leftover .extract dirs
    assert.ok(await exists(join(canonicalDir, 'eprint')), 'eprint written');
    assert.equal(await exists(join(canonicalDir, 'source')), false, 'source/ stays lazy');
    const entries = await readdir(canonicalDir);
    assert.deepEqual(entries.sort(), ['eprint']);
    assert.deepEqual(
      out.attachments.map((x) => x.filename).sort(),
      ['figures/f.png', 'sec.tex'],
    );
  });
});

test('eprint round-trips: tar xzf eprint -C source → source/<main> with original bytes', async () => {
  await withTmp(async (dir) => {
    const body = '# Survey\n\nbody text';
    const zip = await makeZip((a) => {
      a.append(body, { name: 'main.md' });
      a.append(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { name: 'figs/diagram.png' });
    });
    const archivePath = await stage(dir, 'upload.zip', zip);
    const canonicalDir = join(dir, 'doc');

    const out = await materializeArchive({ archivePath, canonicalDir, contentFormat: 'markdown' });
    assert.equal(out.sources.markdown?.rootMd, 'main.md');

    // Replicate parse-strategy's lazy-extract verbatim.
    const sourceDir = join(canonicalDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await execFileAsync('tar', ['xzf', join(canonicalDir, 'eprint'), '-C', sourceDir]);
    assert.equal(await readFile(join(sourceDir, 'main.md'), 'utf-8'), body);
    assert.ok(await exists(join(sourceDir, 'figs/diagram.png')), 'attachment preserved in eprint');
  });
});

test('pdf raw file → paper.pdf, sources.pdf points at it, no eprint', async () => {
  await withTmp(async (dir) => {
    const archivePath = await stage(dir, 'upload.pdf', PDF_BYTES);
    const canonicalDir = join(dir, 'doc');
    const out = await materializeArchive({ archivePath, canonicalDir, contentFormat: 'pdf' });
    assert.equal(out.rawContentPath, join(canonicalDir, 'paper.pdf'));
    assert.deepEqual(out.sources.pdf, { path: join(canonicalDir, 'paper.pdf'), size: PDF_BYTES.length });
    assert.equal(await readFile(join(canonicalDir, 'paper.pdf')).then((b) => b.equals(PDF_BYTES)), true);
    assert.equal(await exists(join(canonicalDir, 'eprint')), false);
  });
});

test('pdf inside a ZIP → extracted to paper.pdf', async () => {
  await withTmp(async (dir) => {
    const zip = await makeZip((a) => a.append(PDF_BYTES, { name: 'paper.pdf' }));
    const archivePath = await stage(dir, 'upload.zip', zip);
    const canonicalDir = join(dir, 'doc');
    const out = await materializeArchive({ archivePath, canonicalDir, contentFormat: 'pdf' });
    assert.equal(out.mainFile, 'paper.pdf');
    assert.equal(await readFile(join(canonicalDir, 'paper.pdf')).then((b) => b.equals(PDF_BYTES)), true);
  });
});

test('single raw .md (non-ZIP content_ref) → wrapped as one-file eprint named main.md', async () => {
  await withTmp(async (dir) => {
    const body = '# Inline markdown upload';
    const archivePath = await stage(dir, 'upload', Buffer.from(body));
    const canonicalDir = join(dir, 'doc');
    const out = await materializeArchive({ archivePath, canonicalDir, contentFormat: 'markdown' });
    assert.equal(out.sources.markdown?.rootMd, 'main.md');
    const sourceDir = join(canonicalDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await execFileAsync('tar', ['xzf', join(canonicalDir, 'eprint'), '-C', sourceDir]);
    assert.equal(await readFile(join(sourceDir, 'main.md'), 'utf-8'), body);
  });
});

test('format mismatch (zip declares latex but holds a .md) → archive_main_file_format_mismatch', async () => {
  await withTmp(async (dir) => {
    const zip = await makeZip((a) => a.append('# md', { name: 'paper.md' }));
    const archivePath = await stage(dir, 'upload.zip', zip);
    await assert.rejects(
      materializeArchive({ archivePath, canonicalDir: join(dir, 'doc'), contentFormat: 'latex' }),
      (e: unknown) => e instanceof ArchiveIntakeError && e.code === 'archive_main_file_format_mismatch',
    );
  });
});

test('pdf format but bytes are not a PDF → archive_main_file_format_mismatch', async () => {
  await withTmp(async (dir) => {
    const archivePath = await stage(dir, 'upload.pdf', Buffer.from('not a pdf'));
    await assert.rejects(
      materializeArchive({ archivePath, canonicalDir: join(dir, 'doc'), contentFormat: 'pdf' }),
      (e: unknown) => e instanceof ArchiveIntakeError && e.code === 'archive_main_file_format_mismatch',
    );
  });
});
