/**
 * Download Papers With Code dataset.
 *
 * Source: https://production-media.paperswithcode.com/about/papers-with-abstracts.json.gz
 * Output: data/pwc/papers-with-abstracts.json
 *
 * Usage: pnpm --filter @openarx/ingest run download-pwc
 */

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('download-pwc');

const PWC_URL =
  'https://production-media.paperswithcode.com/about/papers-with-abstracts.json.gz';
const OUTPUT_DIR = resolve(process.cwd(), 'data', 'pwc');
const OUTPUT_PATH = resolve(OUTPUT_DIR, 'papers-with-abstracts.json');

async function main(): Promise<void> {
  // Ensure output directory exists
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  if (existsSync(OUTPUT_PATH)) {
    const stats = await stat(OUTPUT_PATH);
    const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
    log.info(`PwC data already exists (${sizeMb} MB). Delete to re-download.`);
    console.log(`File exists: ${OUTPUT_PATH} (${sizeMb} MB)`);
    console.log('Delete the file to force re-download.');
    return;
  }

  console.log(`Downloading PwC dataset from:\n  ${PWC_URL}`);
  console.log(`Output: ${OUTPUT_PATH}\n`);

  const start = performance.now();
  const response = await fetch(PWC_URL);

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const gunzip = createGunzip();
  const output = createWriteStream(OUTPUT_PATH);

  // Node fetch body → Node readable → gunzip → file
  const readable = response.body as unknown as NodeJS.ReadableStream;
  await pipeline(readable, gunzip, output);

  const durationMs = Math.round(performance.now() - start);
  const stats = await stat(OUTPUT_PATH);
  const sizeMb = (stats.size / 1024 / 1024).toFixed(1);

  console.log(`\nDownload complete!`);
  console.log(`  Size: ${sizeMb} MB`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Path: ${OUTPUT_PATH}`);

  // Quick stats: count papers
  log.info('Counting papers...');
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(OUTPUT_PATH, 'utf-8');
  const papers = JSON.parse(raw) as Array<{ repositories?: unknown[] }>;

  const withRepos = papers.filter((p) => p.repositories && p.repositories.length > 0).length;
  console.log(`\nStats:`);
  console.log(`  Total papers: ${papers.length.toLocaleString()}`);
  console.log(`  Papers with repos: ${withRepos.toLocaleString()}`);
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
