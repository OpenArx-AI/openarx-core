#!/usr/bin/env tsx
/**
 * Download sample arXiv papers for parser validation (M0).
 *
 * Fetches metadata via arXiv Atom API, downloads PDFs and LaTeX sources.
 * Respects 3-second rate limit between requests.
 *
 * Usage: pnpm --filter @openarx/ingest run download-samples
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { ArxivPaperMetadata } from '@openarx/types';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('download-samples');

// ── Curated sample papers ──
// Mix of cs.LG, cs.CL, cs.CV, cs.AI — with tables, formulas, figures
// Some have LaTeX source, some are PDF-only
const SAMPLE_IDS: string[] = [
  // Transformers & LLMs
  '1706.03762', // Attention Is All You Need
  '2401.04088', // Mixtral of Experts
  '2307.09288', // Llama 2
  '2305.18290', // Direct Preference Optimization (DPO)
  '2210.11416', // Scaling Instruction-Finetuned Models (Flan-T5)

  // Vision
  '2010.11929', // ViT — An Image is Worth 16x16 Words
  '2304.08485', // LLaVA — Visual Instruction Tuning
  '2312.00752', // Mamba — Linear-Time Sequence Modeling

  // Reinforcement Learning / Agents
  '2203.02155', // InstructGPT (Training LMs to Follow Instructions)
  '2305.10601', // Tree of Thoughts

  // Diffusion Models
  '2006.11239', // Denoising Diffusion Probabilistic Models
  '2112.10752', // Stable Diffusion (High-Res Image Synthesis with LDMs)

  // Graph Neural Networks / Scientific ML
  '2105.01601', // GNN Survey (A Comprehensive Survey on GNNs)
  '2106.09685', // LoRA — Low-Rank Adaptation

  // RAG & Retrieval
  '2005.11401', // RAG — Retrieval-Augmented Generation
  '2312.10997', // Retrieval-Augmented Generation for LLMs: A Survey

  // Benchmarks & Evaluation
  '2306.05685', // Judging LLM-as-a-Judge
  '2009.03300', // MMLU (Measuring Massive Multitask Language Understanding)

  // Code & Math
  '2308.12950', // Code Llama
  '2110.14168', // Chain of Thought Prompting

  // Safety & Alignment
  '2204.05862', // Training a Helpful and Harmless AI Assistant (RLHF)
  '2303.08774', // GPT-4 Technical Report

  // Recent (2024+) — likely PDF-only or newer formats
  '2402.05120', // V-JEPA
  '2403.05530', // GaLore (Gradient Low-Rank Projection)
  '2401.02954', // MoE-Mamba
  '2405.04434', // DeepSeek-V2
];

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

async function fetchMetadata(arxivId: string): Promise<ArxivPaperMetadata> {
  const url = `${ARXIV_API}?id_list=${arxivId}&max_results=1`;
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
  const entry = parsed.feed?.entry;

  if (!entry) {
    throw new Error(`No entry found for ${arxivId}`);
  }

  // Extract categories
  const cats = Array.isArray(entry.category)
    ? entry.category.map((c: Record<string, string>) => c['@_term'])
    : [entry.category?.['@_term']].filter(Boolean);

  // Extract authors
  const authorEntries = Array.isArray(entry.author) ? entry.author : [entry.author];
  const authors = authorEntries
    .filter(Boolean)
    .map((a: Record<string, string>) => ({ name: a.name }));

  // Extract PDF link
  const links = Array.isArray(entry.link) ? entry.link : [entry.link];
  const pdfLink = links.find(
    (l: Record<string, string>) => l['@_type'] === 'application/pdf',
  );
  const pdfUrl = pdfLink?.['@_href'] ?? `https://arxiv.org/pdf/${arxivId}`;

  // Clean title/abstract (remove extra whitespace)
  const title = String(entry.title ?? '').replace(/\s+/g, ' ').trim();
  const abstract = String(entry.summary ?? '').replace(/\s+/g, ' ').trim();

  return {
    arxivId,
    title,
    authors,
    abstract,
    categories: cats,
    publishedAt: entry.published,
    updatedAt: entry.updated,
    pdfUrl,
    sourceUrl: `https://arxiv.org/e-print/${arxivId}`,
  };
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
  await pipeline(Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]), ws);
}

async function downloadPaper(arxivId: string): Promise<void> {
  const paperDir = join(DATA_DIR, arxivId.replace('/', '_'));

  // Skip if already downloaded
  if (await exists(join(paperDir, 'metadata.json'))) {
    log.info({ arxivId }, 'Already downloaded, skipping');
    return;
  }

  await mkdir(paperDir, { recursive: true });

  // 1. Fetch metadata
  log.info({ arxivId }, 'Fetching metadata');
  const metadata = await fetchMetadata(arxivId);
  await writeFile(join(paperDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await sleep(RATE_LIMIT_MS);

  // 2. Download PDF
  log.info({ arxivId }, 'Downloading PDF');
  await downloadFile(metadata.pdfUrl, join(paperDir, 'paper.pdf'));
  await sleep(RATE_LIMIT_MS);

  // 3. Try downloading LaTeX source (may fail for some papers)
  if (metadata.sourceUrl) {
    try {
      log.info({ arxivId }, 'Downloading LaTeX source');
      await downloadFile(metadata.sourceUrl, join(paperDir, 'source.tar.gz'));
    } catch (err) {
      log.warn({ arxivId, err }, 'LaTeX source not available');
    }
    await sleep(RATE_LIMIT_MS);
  }

  log.info({ arxivId, title: metadata.title }, 'Download complete');
}

async function main(): Promise<void> {
  log.info({ count: SAMPLE_IDS.length }, 'Starting sample paper download');

  await mkdir(DATA_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const arxivId of SAMPLE_IDS) {
    try {
      const paperDir = join(DATA_DIR, arxivId.replace('/', '_'));
      if (await exists(join(paperDir, 'metadata.json'))) {
        skipped++;
        log.info({ arxivId }, 'Skipping (already exists)');
        continue;
      }
      await downloadPaper(arxivId);
      downloaded++;
    } catch (err) {
      failed++;
      log.error({ arxivId, err }, 'Failed to download paper');
    }
  }

  log.info({ total: SAMPLE_IDS.length, downloaded, skipped, failed }, 'Download complete');
}

main().catch((err) => {
  log.fatal(err, 'Download script failed');
  process.exit(1);
});
