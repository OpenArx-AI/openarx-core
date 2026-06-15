/**
 * Integration tests for LatexStrategy's lazy-extract + cleanup (openarx-yvkp).
 *
 * Real tar.gz fixture is built per-test in an isolated tmp dir, the strategy
 * runs against it, and we assert filesystem state before/after. This covers
 * the actual extract/cleanup wiring without mocking child_process.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LatexStrategy, MarkdownStrategy } from '../parse-strategy.js';
import type { Document, PipelineContext } from '@openarx/types';

const execFileAsync = promisify(execFile);

// Lightweight no-op pipeline context that satisfies the LatexStrategy parse
// signature. Real PipelineContext includes more fields, but the strategy only
// touches `logger` for messages.
const NOOP_CONTEXT = {
  logger: {
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
} as unknown as PipelineContext;

const SCRATCH_ROOTS: string[] = [];
after(async () => {
  for (const d of SCRATCH_ROOTS) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makePaperDirWithArchive(): Promise<{ paperDir: string; eprintPath: string; sourceDir: string }> {
  const paperDir = await mkdtemp(join(tmpdir(), 'openarx-test-paper-'));
  SCRATCH_ROOTS.push(paperDir);

  // Build a minimal LaTeX project in a sibling dir, then tar.gz it into eprint
  const stagingDir = await mkdtemp(join(tmpdir(), 'openarx-test-staging-'));
  SCRATCH_ROOTS.push(stagingDir);
  await writeFile(
    join(stagingDir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nHello \\LaTeX\\ world.\n\\end{document}\n',
  );
  await writeFile(join(stagingDir, 'refs.bib'), '@article{foo,title={Foo}}\n');

  const eprintPath = join(paperDir, 'eprint');
  await execFileAsync('tar', ['czf', eprintPath, '-C', stagingDir, '.']);

  return { paperDir, eprintPath, sourceDir: join(paperDir, 'source') };
}

function makeDocWithLatexSource(sourceDir: string): Document {
  return {
    sources: { latex: { path: sourceDir, manifest: false, texFiles: 1 } },
    sourceFormat: 'latex',
  } as unknown as Document;
}

test('lazy-extract: missing source/ → extract eprint → parse → cleanup', async () => {
  const { eprintPath, sourceDir } = await makePaperDirWithArchive();
  const doc = makeDocWithLatexSource(sourceDir);
  const strategy = new LatexStrategy();

  // Precondition: source/ does NOT exist
  let exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'source/ should not exist before parse');

  const parsed = await strategy.parse(doc, NOOP_CONTEXT);
  assert.ok(parsed.sections, 'parser should produce sections');

  // Postcondition: source/ is cleaned up
  exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'source/ should be cleaned up after parse');

  // eprint must remain intact
  await access(eprintPath);
});

test('legacy path: source/ already present + non-empty → still cleaned up after parse', async () => {
  const { eprintPath, sourceDir } = await makePaperDirWithArchive();
  // Pre-extract source/ (simulates a legacy document where ingest persisted it)
  await mkdir(sourceDir, { recursive: true });
  await execFileAsync('tar', ['xzf', eprintPath, '-C', sourceDir]);
  const beforeFiles = await readdir(sourceDir);
  assert.ok(beforeFiles.length > 0, 'pre-extracted source/ should have files');

  const doc = makeDocWithLatexSource(sourceDir);
  const strategy = new LatexStrategy();
  await strategy.parse(doc, NOOP_CONTEXT);

  // After parse, source/ cleaned up
  let exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'legacy source/ should be cleaned up after parse');
  await access(eprintPath);
});

test('cleanup is skipped when eprint is missing (defensive: never leave doc with neither)', async () => {
  const { eprintPath, sourceDir } = await makePaperDirWithArchive();
  // Pre-extract source/ so parser has something to read
  await mkdir(sourceDir, { recursive: true });
  await execFileAsync('tar', ['xzf', eprintPath, '-C', sourceDir]);
  // Delete eprint — now we have ONLY source/, deleting it would lose data
  await rm(eprintPath);

  const doc = makeDocWithLatexSource(sourceDir);
  const strategy = new LatexStrategy();
  await strategy.parse(doc, NOOP_CONTEXT);

  // source/ MUST still be present
  const files = await readdir(sourceDir);
  assert.ok(files.length > 0, 'source/ must NOT be deleted when eprint is missing');
});

// ── MarkdownStrategy lazy-extract + grandfathered (openarx-contracts-w7um §17.4/§17.7) ──

async function makeMarkdownPaperDirWithArchive(): Promise<{ paperDir: string; eprintPath: string; sourceDir: string }> {
  const paperDir = await mkdtemp(join(tmpdir(), 'openarx-test-mdpaper-'));
  SCRATCH_ROOTS.push(paperDir);
  const stagingDir = await mkdtemp(join(tmpdir(), 'openarx-test-mdstaging-'));
  SCRATCH_ROOTS.push(stagingDir);
  await writeFile(
    join(stagingDir, 'main.md'),
    '# Cognitive Asymmetry\n\nThis is a survey body with enough prose to chunk.\n\n## Background\n\nMore content here.\n',
  );
  await mkdir(join(stagingDir, 'figs'), { recursive: true });
  await writeFile(join(stagingDir, 'figs', 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const eprintPath = join(paperDir, 'eprint');
  await execFileAsync('tar', ['czf', eprintPath, '-C', stagingDir, '.']);
  return { paperDir, eprintPath, sourceDir: join(paperDir, 'source') };
}

function makeDocWithMarkdownSource(path: string, rootMd?: string): Document {
  return {
    sources: { markdown: { path, rootMd } },
    sourceFormat: 'markdown',
  } as unknown as Document;
}

test('A10 markdown lazy-extract: eprint → source/ → parse main.md → cleanup (rootMd set)', async () => {
  const { eprintPath, sourceDir } = await makeMarkdownPaperDirWithArchive();
  const doc = makeDocWithMarkdownSource(sourceDir, 'main.md');
  const strategy = new MarkdownStrategy();

  let exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'source/ should not exist before parse');

  const parsed = await strategy.parse(doc, NOOP_CONTEXT);
  assert.ok(parsed.sections, 'parser should produce sections');

  exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'source/ should be cleaned up after parse');
  await access(eprintPath); // eprint retained as the canonical archive
});

test('A10 markdown lazy-extract: rootMd absent → single root .md auto-detected', async () => {
  const { eprintPath, sourceDir } = await makeMarkdownPaperDirWithArchive();
  const doc = makeDocWithMarkdownSource(sourceDir); // no rootMd
  const strategy = new MarkdownStrategy();
  const parsed = await strategy.parse(doc, NOOP_CONTEXT);
  assert.ok(parsed.sections, 'auto-detected main.md parsed');
  await access(eprintPath);
  let exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'source/ cleaned up');
});

test('A11 grandfathered markdown: single .md, NO eprint sibling → parsed in place, file kept', async () => {
  const paperDir = await mkdtemp(join(tmpdir(), 'openarx-test-mdlegacy-'));
  SCRATCH_ROOTS.push(paperDir);
  const mdPath = join(paperDir, 'survey.md');
  await writeFile(mdPath, '# Grandfathered Survey\n\nOriginal single-file body text.\n');

  const doc = makeDocWithMarkdownSource(mdPath); // path IS the .md file; no eprint
  const strategy = new MarkdownStrategy();
  const parsed = await strategy.parse(doc, NOOP_CONTEXT);
  assert.ok(parsed.sections, 'grandfathered .md parsed via fallback');

  // The original file MUST remain (grandfathered docs are not archived)
  await access(mdPath);
});

test('extract failure (corrupted eprint) throws and cleans the half-extracted dir', async () => {
  const paperDir = await mkdtemp(join(tmpdir(), 'openarx-test-paper-'));
  SCRATCH_ROOTS.push(paperDir);
  const sourceDir = join(paperDir, 'source');
  const eprintPath = join(paperDir, 'eprint');
  // Write garbage as "eprint"
  await writeFile(eprintPath, Buffer.from('not-a-tar-archive'));

  const doc = makeDocWithLatexSource(sourceDir);
  const strategy = new LatexStrategy();

  await assert.rejects(
    () => strategy.parse(doc, NOOP_CONTEXT),
    /Failed to extract eprint for LaTeX parse/,
  );

  // No leftover source/ from a failed extract
  let exists = true;
  try { await access(sourceDir); } catch { exists = false; }
  assert.equal(exists, false, 'source/ should be cleaned up after extract failure');
});
