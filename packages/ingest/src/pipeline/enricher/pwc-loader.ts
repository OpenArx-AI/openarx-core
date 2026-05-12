/**
 * PwC (Papers With Code) dataset loader.
 *
 * Loads papers-with-abstracts.json and builds a lookup map keyed by arXiv ID.
 * Provides code repos, datasets, and tasks for a given paper.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger('pwc-loader');

export interface PwcRepo {
  url: string;
  stars?: number;
  language?: string;
}

export interface PwcEntry {
  repos: PwcRepo[];
  datasets: string[];
  tasks: string[];
}

// Shape of entries in papers-with-abstracts.json
interface PwcRawPaper {
  paper_url?: string;
  arxiv_id?: string;
  url_abs?: string;
  proceeding?: string;
  tasks?: Array<{ task: string }>;
  repositories?: Array<{
    url: string;
    stars?: number;
    framework?: string;
  }>;
  datasets?: Array<{ dataset: string }>;
  methods?: unknown[];
}

const ARXIV_ID_RE = /arxiv\.org\/abs\/([\d.]+)/;

export class PwcLoader {
  private map = new Map<string, PwcEntry>();
  private loaded = false;

  constructor(private readonly dataPath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;

    if (!existsSync(this.dataPath)) {
      log.warn({ path: this.dataPath }, 'PwC data file not found — lookups will return null');
      this.loaded = true;
      return;
    }

    log.info({ path: this.dataPath }, 'Loading PwC dataset...');
    const start = performance.now();

    const raw = await readFile(this.dataPath, 'utf-8');
    const papers = JSON.parse(raw) as PwcRawPaper[];

    for (const paper of papers) {
      const arxivId = this.extractArxivId(paper);
      if (!arxivId) continue;

      const repos: PwcRepo[] = (paper.repositories ?? [])
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url,
          stars: r.stars,
          language: r.framework,
        }));

      const datasets = (paper.datasets ?? [])
        .map((d) => d.dataset)
        .filter(Boolean);

      const tasks = (paper.tasks ?? [])
        .map((t) => t.task)
        .filter(Boolean);

      if (repos.length > 0 || datasets.length > 0 || tasks.length > 0) {
        this.map.set(arxivId, { repos, datasets, tasks });
      }
    }

    const durationMs = Math.round(performance.now() - start);
    log.info(
      { totalPapers: papers.length, indexed: this.map.size, durationMs },
      'PwC dataset loaded',
    );

    this.loaded = true;
  }

  lookup(arxivId: string): PwcEntry | null {
    return this.map.get(arxivId) ?? null;
  }

  get size(): number {
    return this.map.size;
  }

  private extractArxivId(paper: PwcRawPaper): string | null {
    if (paper.arxiv_id) return paper.arxiv_id;

    const url = paper.paper_url ?? paper.url_abs ?? '';
    const match = ARXIV_ID_RE.exec(url);
    return match ? match[1] : null;
  }
}
