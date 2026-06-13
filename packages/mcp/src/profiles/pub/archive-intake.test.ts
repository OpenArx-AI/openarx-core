/**
 * openarx-contracts-nie7: archive intake validation matrix (acceptance 1–13
 * unit part). ZIPs are generated in-test with archiver; extraction limits
 * are injected small so zip-bomb cases stay fast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import archiver from 'archiver';
import {
  decodeArchive,
  extractArchive,
  resolveMainFile,
  checkFormatMatch,
  buildAttachments,
  isUnsafeEntryPath,
  ArchiveIntakeError,
} from './archive-intake.js';
import { validateContentInputs, archiveField } from './publish-tools.js';

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
  const dir = await mkdtemp(join(tmpdir(), 'oarx-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function code(e: unknown): string {
  assert.ok(e instanceof ArchiveIntakeError, `expected ArchiveIntakeError, got ${String(e)}`);
  return e.code;
}

// ── refines (acceptance 1, 2) ────────────────────────────────────────────

test('content_text + archive together → mutually exclusive error', () => {
  const r = validateContentInputs('markdown', '# x', 'UEsDBA==');
  assert.ok(r && r.message.includes('mutually exclusive'));
});

test('neither content_text nor archive → at-least-one error (incl. pdf)', () => {
  const md = validateContentInputs('markdown', undefined, undefined);
  assert.ok(md && md.message.includes('content_text is required')); // flrw envelope kept
  const pdf = validateContentInputs('pdf', undefined, undefined);
  assert.ok(pdf && pdf.message.includes('Either content_text or content_archive_base64'));
});

test('archive alone passes input validation for every format', () => {
  for (const f of ['latex', 'markdown', 'pdf'] as const) {
    assert.equal(validateContentInputs(f, undefined, 'UEsDBA=='), null);
  }
});

// ── decode: base64 / magic / size (acceptance 3, 4, 5, 6) ───────────────

test('invalid base64 → invalid_base64', () => {
  assert.throws(() => decodeArchive('not-base64!!!'), (e: unknown) => code(e) === 'invalid_base64');
});

test('valid base64 of non-ZIP bytes (a PDF) → archive_not_zip', () => {
  const pdfBytes = Buffer.from('%PDF-1.4 fake');
  assert.throws(() => decodeArchive(pdfBytes.toString('base64')), (e: unknown) => code(e) === 'archive_not_zip');
});

test('zod field caps encoded size at 67,000,000', () => {
  assert.equal(archiveField.safeParse('A'.repeat(67_000_001)).success, false);
});

test('decoded size above the cap → archive_too_large_decoded', async () => {
  // random bytes are incompressible — the zip itself exceeds the cap
  const { randomBytes } = await import('node:crypto');
  const zip = await makeZip((a) => a.append(randomBytes(64 * 1024), { name: 'paper.md' }));
  assert.throws(
    () => decodeArchive(zip.toString('base64'), { decodedMax: 1024 }),
    (e: unknown) => code(e) === 'archive_too_large_decoded',
  );
});

// ── extract: bomb / traversal / symlink (acceptance 7, 8, 9, 10) ────────

test('actual uncompressed bytes above cap → archive_uncompressed_too_large', async () => {
  // 1 MB of zeros compresses to ~1 KB; cap at 64 KB → caught mid-inflate.
  const zip = await makeZip((a) => a.append(Buffer.alloc(1024 * 1024), { name: 'paper.md' }));
  await withTmp(async (dir) => {
    await assert.rejects(
      extractArchive(zip, dir, { uncompressedMax: 64 * 1024 }),
      (e: unknown) => code(e) === 'archive_uncompressed_too_large',
    );
  });
});

test('entry with ../ path → archive_path_traversal', async () => {
  // archiver sanitizes ../ in entry names, so build a benign zip with an
  // equal-length placeholder name and byte-patch it into '../evil.md' —
  // filenames are not covered by the entry CRC.
  const zip = await makeZip((a) => a.append('x', { name: 'AA/evil.md' }));
  const placeholder = Buffer.from('AA/evil.md');
  const evil = Buffer.from('../evil.md');
  let idx = zip.indexOf(placeholder);
  assert.ok(idx !== -1, 'placeholder name not found in zip');
  while (idx !== -1) {
    evil.copy(zip, idx);
    idx = zip.indexOf(placeholder, idx + 1);
  }
  await withTmp(async (dir) => {
    await assert.rejects(extractArchive(zip, dir), (e: unknown) => code(e) === 'archive_path_traversal');
    assert.deepEqual(await readdir(dir), []); // nothing escaped or landed
  });
});

test('entry with absolute path → archive_path_traversal', () => {
  // archiver normalizes absolute names, so assert the predicate directly
  assert.equal(isUnsafeEntryPath('/etc/passwd'), true);
  assert.equal(isUnsafeEntryPath('C:\\windows\\evil'), true);
  assert.equal(isUnsafeEntryPath('figures/fig1.png'), false);
});

test('symlink entry → archive_symlink_entry', async () => {
  const zip = await makeZip((a) => {
    a.append('# ok', { name: 'paper.md' });
    a.symlink('link.md', '/etc/passwd');
  });
  await withTmp(async (dir) => {
    await assert.rejects(extractArchive(zip, dir), (e: unknown) => code(e) === 'archive_symlink_entry');
  });
});

// ── main_file resolution (acceptance 11, 12, 13) ─────────────────────────

test('two root candidates without main_file → archive_main_file_required with both listed', () => {
  const files = [{ filename: 'paper.md', size: 10 }, { filename: 'paper.pdf', size: 10 }];
  try {
    resolveMainFile(files, undefined);
    assert.fail('should throw');
  } catch (e) {
    assert.equal(code(e), 'archive_main_file_required');
    assert.deepEqual((e as ArchiveIntakeError).details?.candidates, ['paper.md', 'paper.pdf']);
  }
});

test('single root pdf auto-inferred; nested files ignored for inference', () => {
  const files = [
    { filename: 'paper.pdf', size: 10 },
    { filename: 'figures/extra.md', size: 5 },
  ];
  assert.equal(resolveMainFile(files, undefined), 'paper.pdf');
});

test('explicit main_file must exist', () => {
  assert.throws(
    () => resolveMainFile([{ filename: 'paper.md', size: 1 }], 'other.md'),
    (e: unknown) => code(e) === 'archive_main_file_not_found',
  );
});

test('extension/content_format mismatch → archive_main_file_format_mismatch', () => {
  assert.throws(() => checkFormatMatch('paper.md', 'pdf'), (e: unknown) => code(e) === 'archive_main_file_format_mismatch');
  // matches pass
  checkFormatMatch('paper.pdf', 'pdf');
  checkFormatMatch('main.tex', 'latex');
  checkFormatMatch('paper.markdown', 'markdown');
});

// ── end-to-end extract happy path + attachments ──────────────────────────

test('markdown + figures archive extracts and builds attachments', async () => {
  const zip = await makeZip((a) => {
    a.append('# Paper\n![f](figures/fig1.png)', { name: 'paper.md' });
    a.append(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { name: 'figures/fig1.png' });
    a.append(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { name: 'figures/fig2.png' });
  });
  await withTmp(async (dir) => {
    const buf = decodeArchive(zip.toString('base64'));
    const files = await extractArchive(buf, dir);
    const mainFile = resolveMainFile(files, undefined);
    assert.equal(mainFile, 'paper.md');
    const atts = buildAttachments(files, mainFile);
    assert.deepEqual(atts.map((x) => x.filename).sort(), ['figures/fig1.png', 'figures/fig2.png']);
    assert.ok(atts.every((x) => x.type === 'image/png'));
  });
});
