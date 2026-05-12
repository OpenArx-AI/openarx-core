#!/usr/bin/env tsx
/**
 * Batch-fetch arXiv papers by category search.
 *
 * Queries arXiv API for recent cs.AI/cs.CL papers, downloads metadata + PDFs,
 * skips already-downloaded papers. Respects 3-second rate limit.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run batch-fetch [--limit 100] [--category cs.AI]
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('batch-fetch');

const DATA_DIR = join(process.cwd(), '../../data/samples/arxiv');
const ARXIV_API = 'https://export.arxiv.org/api/query';
const RATE_LIMIT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface ArxivEntry {
  arxivId: string;
  title: string;
  authors: { name: string }[];
  abstract: string;
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  pdfUrl: string;
}

async function searchArxiv(
  categories: string[],
  maxResults: number,
  start = 0,
): Promise<ArxivEntry[]> {
  const catQuery = categories.map((c) => `cat:${c}`).join('+OR+');
  const url = `${ARXIV_API}?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${maxResults}`;

  log.info({ url, maxResults, start }, 'Querying arXiv API');
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`arXiv API error: ${resp.status} ${resp.statusText}`);
  }

  const xml = await resp.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });
  const parsed = parser.parse(xml);

  const entries = Array.isArray(parsed.feed?.entry)
    ? parsed.feed.entry
    : parsed.feed?.entry
      ? [parsed.feed.entry]
      : [];

  return entries.map((entry: Record<string, unknown>) => {
    // Extract arxiv ID from the entry id URL
    const idUrl = String(entry.id ?? '');
    const idMatch = /\/abs\/(\d{4}\.\d{4,5})(v\d+)?$/.exec(idUrl);
    const arxivId = idMatch ? idMatch[1] : idUrl;

    const cats = Array.isArray(entry.category)
      ? (entry.category as Record<string, string>[]).map((c) => c['@_term'])
      : [
          (entry.category as Record<string, string> | undefined)?.['@_term'],
        ].filter(Boolean);

    const authorEntries = Array.isArray(entry.author)
      ? entry.author
      : [entry.author];
    const authors = (authorEntries as Record<string, string>[])
      .filter(Boolean)
      .map((a) => ({ name: a.name }));

    const links = Array.isArray(entry.link)
      ? entry.link
      : [entry.link];
    const pdfLink = (links as Record<string, string>[]).find(
      (l) => l['@_type'] === 'application/pdf',
    );
    const pdfUrl =
      pdfLink?.['@_href'] ?? `https://arxiv.org/pdf/${arxivId}`;

    const title = String(entry.title ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const abstract = String(entry.summary ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      arxivId,
      title,
      authors,
      abstract,
      categories: cats as string[],
      publishedAt: String(entry.published ?? ''),
      updatedAt: String(entry.updated ?? ''),
      pdfUrl,
    };
  });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${url}`);
  }
  if (!resp.body) {
    throw new Error(`No body in response: ${url}`);
  }
  const ws = createWriteStream(destPath);
  await pipeline(
    Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]),
    ws,
  );
}

function parseArgs(): { limit: number; categories: string[] } {
  const args = process.argv.slice(2);
  let limit = 100;
  const categories = ['cs.AI', 'cs.CL'];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--category' && args[i + 1]) {
      categories.length = 0;
      categories.push(args[i + 1]);
      i++;
    }
  }

  return { limit, categories };
}

async function main(): Promise<void> {
  const { limit, categories } = parseArgs();

  log.info({ limit, categories }, 'Starting batch fetch');
  await mkdir(DATA_DIR, { recursive: true });

  // Fetch more than needed to account for existing papers
  const fetchSize = Math.min(limit + 50, 200);
  const allEntries = await searchArxiv(categories, fetchSize);
  await sleep(RATE_LIMIT_MS);

  log.info({ fetched: allEntries.length }, 'Got arXiv search results');

  // Filter: skip entries with no valid arxiv ID or that already exist locally
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of allEntries) {
    if (downloaded >= limit) break;

    if (!entry.arxivId || entry.arxivId.includes('/')) {
      skipped++;
      continue;
    }

    const paperDir = join(DATA_DIR, entry.arxivId);

    if (await exists(join(paperDir, 'metadata.json'))) {
      log.debug({ arxivId: entry.arxivId }, 'Already downloaded, skipping');
      skipped++;
      continue;
    }

    try {
      await mkdir(paperDir, { recursive: true });

      // Save metadata
      await writeFile(
        join(paperDir, 'metadata.json'),
        JSON.stringify(
          {
            arxivId: entry.arxivId,
            title: entry.title,
            authors: entry.authors,
            abstract: entry.abstract,
            categories: entry.categories,
            publishedAt: entry.publishedAt,
            updatedAt: entry.updatedAt,
            pdfUrl: entry.pdfUrl,
            sourceUrl: `https://arxiv.org/e-print/${entry.arxivId}`,
          },
          null,
          2,
        ),
      );

      // Download PDF
      log.info(
        { arxivId: entry.arxivId, title: entry.title.slice(0, 60) },
        'Downloading PDF',
      );
      await downloadFile(entry.pdfUrl, join(paperDir, 'paper.pdf'));
      downloaded++;

      log.info(
        { arxivId: entry.arxivId, downloaded, total: limit },
        'Downloaded',
      );
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ arxivId: entry.arxivId, err: msg }, 'Failed to download');
      // Clean up partial download
      try {
        const { rm } = await import('node:fs/promises');
        await rm(paperDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      await sleep(RATE_LIMIT_MS);
    }
  }

  console.log(`\n=== Batch Fetch Complete ===`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Total available: ${allEntries.length}`);
}

main().catch((err) => {
  log.fatal(err, 'Batch fetch failed');
  process.exit(1);
});
