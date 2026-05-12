/**
 * ArxivLocalAdapter — scans local directory of downloaded arXiv papers.
 *
 * Reads metadata.json + paper.pdf from each subfolder under the configured
 * data directory (default: data/samples/arxiv/).
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ArxivPaperMetadata,
  FetchOptions,
  RawDocument,
  SourceAdapter,
} from '@openarx/types';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('arxiv-local');

const DEFAULT_DATA_DIR = resolve(
  process.cwd(),
  '../../data/samples/arxiv',
);

export interface ArxivLocalAdapterConfig {
  dataDir?: string;
}

export class ArxivLocalAdapter implements SourceAdapter {
  readonly name = 'arxiv-local';
  private readonly dataDir: string;

  constructor(config?: ArxivLocalAdapterConfig) {
    this.dataDir = config?.dataDir ?? DEFAULT_DATA_DIR;
  }

  async *fetch(options: FetchOptions): AsyncGenerator<RawDocument> {
    log.info({ dataDir: this.dataDir, options }, 'Scanning local arXiv papers');

    let entries: string[];
    try {
      entries = await readdir(this.dataDir);
    } catch (err) {
      log.error({ err, dataDir: this.dataDir }, 'Failed to read data directory');
      return;
    }

    // Sort for deterministic ordering
    entries.sort();

    let yielded = 0;

    for (const entry of entries) {
      if (options.limit && yielded >= options.limit) break;

      const paperDir = join(this.dataDir, entry);
      const metadataPath = join(paperDir, 'metadata.json');
      const pdfPath = join(paperDir, 'paper.pdf');

      // Check both files exist
      try {
        await access(metadataPath);
        await access(pdfPath);
      } catch {
        log.debug({ entry }, 'Skipping — missing metadata.json or paper.pdf');
        continue;
      }

      const raw = await readFile(metadataPath, 'utf-8');
      const meta: ArxivPaperMetadata = JSON.parse(raw);

      // Apply category filter
      if (options.categories?.length) {
        const hasMatch = meta.categories.some((c) =>
          options.categories!.includes(c),
        );
        if (!hasMatch) continue;
      }

      // Apply date filters
      const pubDate = new Date(meta.publishedAt);
      if (options.dateFrom && pubDate < new Date(options.dateFrom)) continue;
      if (options.dateTo && pubDate > new Date(options.dateTo)) continue;

      const doc: RawDocument = {
        sourceId: meta.arxivId,
        title: meta.title,
        authors: meta.authors.map((a) => ({ name: a.name })),
        abstract: meta.abstract,
        categories: meta.categories,
        publishedAt: pubDate,
        pdfUrl: meta.pdfUrl,
        pdfPath,
        latexSourceUrl: meta.sourceUrl,
        metadata: meta as unknown as Record<string, unknown>,
      };

      yielded++;
      log.debug({ arxivId: meta.arxivId, yielded }, 'Yielding paper');
      yield doc;
    }

    log.info({ total: yielded }, 'Local scan complete');
  }
}
