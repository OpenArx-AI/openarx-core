/**
 * ArxivSource — encapsulates all arXiv-specific logic:
 *   - API queries with date-based pagination
 *   - e-print + PDF download
 *   - LaTeX source detection (tar.gz vs PDF-only)
 *   - Document creation with `sources` JSONB
 */

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Document, DocumentSources } from '@openarx/types';
import type { PgDocumentStore } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';
import { arxivDocPath } from '../utils/doc-path.js';
import { normalizeLicense, computeEffectiveLicense } from '../lib/license-normalizer.js';
import { fetchWithProxy } from '../lib/proxy-pool.js';

const execFileAsync = promisify(execFile);

const log = createChildLogger('arxiv-source');

const ARXIV_API = 'https://export.arxiv.org/api/query';
const RATE_LIMIT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ArxivEntry {
  arxivId: string;
  title: string;
  authors: { name: string }[];
  abstract: string;
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  pdfUrl: string;
  doi?: string;
  journalRef?: string;
}

export interface ArxivSourceConfig {
  dataDir: string;
}

export interface DownloadResult {
  document: Document;
  sourceFormat: 'latex' | 'pdf';
}

export class ArxivSource {
  private readonly dataDir: string;

  constructor(config: ArxivSourceConfig) {
    this.dataDir = config.dataDir;
  }

  // ─── API queries ─────────────────────────────────────────

  /**
   * Fetch newest papers (for forward pass). No date scoping, no category
   * filter — returns all arxiv papers sorted by submitted date desc. Caller
   * applies any per-run category filter post-fetch.
   */
  async searchNewest(maxResults: number, signal?: AbortSignal): Promise<{ total: number; entries: ArxivEntry[] }> {
    // arxiv API requires a search_query — use `all:*` as a wide match (returns
    // every paper, then sort/limit by submittedDate).
    const url = `${ARXIV_API}?search_query=all:*&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${maxResults}`;
    return this.fetchAndParse(url, 'searchNewest', signal);
  }

  /**
   * Fetch papers SUBMITTED on a specific date (YYYYMMDD) with start offset.
   * For backfill. No category filter — returns ALL arxiv papers submitted
   * that day across every subject group. Caller applies any per-run
   * category filter post-fetch (in produceDayDownloads).
   */
  async searchByDateWindow(
    date: string,
    start: number,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<{ total: number; entries: ArxivEntry[] }> {
    const dateRange = `submittedDate:%5B${date}+TO+${date}%5D`;
    const url = `${ARXIV_API}?search_query=${dateRange}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${maxResults}`;
    return this.fetchAndParse(url, `dateWindow:${date}:${start}`, signal);
  }

  private async fetchAndParse(url: string, label: string, signal?: AbortSignal): Promise<{ total: number; entries: ArxivEntry[] }> {
    log.info({ url, label }, 'Querying arXiv API');

    // API queries rotate across 4 IPs from different subnets:
    // direct (production), then 3 proxy servers on different /24s
    const API_PROXIES = (process.env.API_PROXY_SERVERS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    // Index 0 = direct, 1+ = proxies
    const apiEndpoints = ['direct', ...API_PROXIES];
    const CYCLE_BACKOFF = 30_000;
    // No max cycle limit — keep trying until arXiv responds or process is killed.
    // arXiv instability can last hours; we must be patient and opportunistic.
    const MAX_CYCLES = Infinity;

    let resp: Response | undefined;
    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
      for (let i = 0; i < apiEndpoints.length; i++) {
        const endpoint = apiEndpoints[i];
        try {
          const fetchTimeout = AbortSignal.timeout(30_000); // 30s per request
          if (endpoint === 'direct') {
            resp = await fetch(url, { signal: fetchTimeout });
          } else {
            const { ProxyAgent } = await import('undici');
            resp = await fetch(url, { dispatcher: new ProxyAgent(endpoint), signal: fetchTimeout } as RequestInit);
          }
          if (resp.ok) break;
          if (resp.status === 429 || resp.status === 503) {
            log.debug({ endpoint, cycle, status: resp.status }, 'arXiv API unavailable, rotating');
            continue;
          }
          log.warn({ status: resp.status, endpoint }, 'arXiv API error');
        } catch (err) {
          log.warn({ endpoint, err: (err as Error).message }, 'arXiv API request failed');
        }
      }
      if (resp?.ok) break;
      // Check abort signal (from runner graceful stop)
      if (signal?.aborted) {
        throw new Error('arXiv API fetch aborted (stop requested)');
      }
      // Log every 3rd cycle at WARN, rest at DEBUG
      const logFn = cycle % 3 === 0 ? log.warn.bind(log) : log.debug.bind(log);
      logFn({ cycle, wait: CYCLE_BACKOFF / 1000, endpoints: apiEndpoints.length }, 'All API endpoints unavailable, backing off');
      await sleep(CYCLE_BACKOFF);
    }
    if (!resp?.ok) throw new Error(`arXiv API error: ${resp?.status ?? 'no response'} after retries`);

    const xml = await resp.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });
    const parsed = parser.parse(xml);
    await sleep(RATE_LIMIT_MS);

    const totalMatch = String(parsed.feed?.totalResults ?? parsed.feed?.['opensearch:totalResults'] ?? '0');
    const total = parseInt(totalMatch, 10);

    const rawEntries = Array.isArray(parsed.feed?.entry)
      ? parsed.feed.entry
      : parsed.feed?.entry ? [parsed.feed.entry] : [];

    const entries = rawEntries.map((entry: Record<string, unknown>) => {
      const idUrl = String(entry.id ?? '');
      const idMatch = /\/abs\/(\d{4}\.\d{4,5})(v\d+)?$/.exec(idUrl);
      const arxivId = idMatch ? idMatch[1] : idUrl;

      const cats = Array.isArray(entry.category)
        ? (entry.category as Record<string, string>[]).map((c) => c['@_term'])
        : [(entry.category as Record<string, string> | undefined)?.['@_term']].filter(Boolean);

      const authorEntries = Array.isArray(entry.author) ? entry.author : [entry.author];
      const authors = (authorEntries as Record<string, string>[]).filter(Boolean).map((a) => ({ name: a.name }));

      const links = Array.isArray(entry.link) ? entry.link : [entry.link];
      const pdfLink = (links as Record<string, string>[]).find((l) => l['@_type'] === 'application/pdf');
      const pdfUrl = pdfLink?.['@_href'] ?? `https://arxiv.org/pdf/${arxivId}`;

      // Parse optional DOI and journal_ref (arxiv: namespace stripped by removeNSPrefix)
      const doi = entry.doi ? String(entry.doi) : undefined;
      const journalRef = entry.journal_ref ? String(entry.journal_ref) : undefined;

      return {
        arxivId,
        title: String(entry.title ?? '').replace(/\s+/g, ' ').trim(),
        authors,
        abstract: String(entry.summary ?? '').replace(/\s+/g, ' ').trim(),
        categories: cats as string[],
        publishedAt: String(entry.published ?? ''),
        updatedAt: String(entry.updated ?? ''),
        pdfUrl,
        doi,
        journalRef,
      };
    });

    return { total, entries };
  }

  // ─── Download + Register ─────────────────────────────────

  async downloadAndRegister(
    entry: ArxivEntry,
    documentStore: PgDocumentStore,
  ): Promise<DownloadResult> {
    const paperDir = arxivDocPath(entry.arxivId, this.dataDir);
    await mkdir(paperDir, { recursive: true });

    // Step 0: Fetch OAI-PMH metadata in parallel with eprint download.
    // OAI-PMH gives us the canonical license + richer metadata (msc-class,
    // journal-ref, structured authors, etc.). We save raw XML to disk as
    // audit trail; for now we only extract license from it.
    log.info({ arxivId: entry.arxivId, title: entry.title.slice(0, 60) }, 'Downloading e-print');
    const eprintPath = join(paperDir, 'eprint');
    const [, oaiResult] = await Promise.all([
      this.downloadFile(`https://arxiv.org/e-print/${entry.arxivId}`, eprintPath),
      this.fetchOaiMetadata(entry.arxivId),
    ]);
    await sleep(RATE_LIMIT_MS);

    // Save raw OAI XML next to metadata.json for future use
    if (oaiResult.rawXml) {
      await writeFile(join(paperDir, 'oai_arxiv.xml'), oaiResult.rawXml, 'utf-8');
    }

    // Normalize license from OAI response
    const licenseInfo = normalizeLicense(oaiResult.license);
    const licenses: Record<string, string> = {};
    if (licenseInfo.spdx !== 'NOASSERTION') {
      licenses.arxiv_oai = licenseInfo.spdx;
    }
    const licenseEffective = computeEffectiveLicense(licenses);

    // DEBUG: license extraction trace
    log.debug({
      arxivId: entry.arxivId,
      oai_xml_received: !!oaiResult.rawXml,
      oai_license_raw: oaiResult.license,
      normalized_spdx: licenseInfo.spdx,
      is_open: licenseInfo.is_open,
      effective_license: licenseEffective,
      licenses_map: licenses,
    }, '[license-extract] arxiv_oai license extracted');

    // Save processed metadata.json (now includes license block)
    await writeFile(
      join(paperDir, 'metadata.json'),
      JSON.stringify({
        arxivId: entry.arxivId,
        title: entry.title,
        authors: entry.authors,
        abstract: entry.abstract,
        categories: entry.categories,
        publishedAt: entry.publishedAt,
        updatedAt: entry.updatedAt,
        pdfUrl: entry.pdfUrl,
        sourceUrl: `https://arxiv.org/abs/${entry.arxivId}`,
        ...(oaiResult.license
          ? {
              license: {
                arxiv_oai: {
                  spdx: licenseInfo.spdx,
                  raw: licenseInfo.raw,
                },
              },
            }
          : {}),
      }, null, 2),
    );

    // Step 2: Detect format and extract LaTeX if available
    const sources: DocumentSources = {};
    let sourceFormat: 'latex' | 'pdf' = 'pdf';

    const isGzip = await this.isGzipFile(eprintPath);
    if (isGzip) {
      // tar.gz → extract LaTeX source
      const sourceDir = join(paperDir, 'source');
      await mkdir(sourceDir, { recursive: true });
      try {
        await execFileAsync('tar', ['xzf', eprintPath, '-C', sourceDir]);
        // Count .tex files and find root
        const rootTex = await this.findRootTex(sourceDir);
        const texCount = await this.countFiles(sourceDir, '.tex');

        sources.latex = {
          path: sourceDir,
          rootTex: rootTex ?? undefined,
          manifest: await this.hasManifest(sourceDir),
          texFiles: texCount,
        };
        sourceFormat = 'latex';
        log.info({ arxivId: entry.arxivId, rootTex, texFiles: texCount }, 'LaTeX source extracted');
      } catch (err) {
        log.warn({ arxivId: entry.arxivId, err: (err as Error).message }, 'Failed to extract e-print, treating as PDF-only');
      }
    }

    // Step 3: Download PDF (always, for fallback and viewing)
    const pdfPath = join(paperDir, 'paper.pdf');
    if (!isGzip) {
      // e-print was the PDF itself — just rename
      const { rename } = await import('node:fs/promises');
      await rename(eprintPath, pdfPath);
    } else {
      // Download PDF separately
      log.info({ arxivId: entry.arxivId }, 'Downloading PDF');
      await this.downloadFile(entry.pdfUrl, pdfPath);
      await sleep(RATE_LIMIT_MS);
    }

    const pdfStat = await stat(pdfPath).catch(() => null);
    sources.pdf = { path: pdfPath, size: pdfStat?.size };

    // Step 4: Register in DB
    const oarxId = 'oarx-' + createHash('sha256').update(`arxiv:${entry.arxivId}`).digest('hex').slice(0, 8);
    const doc: Document = {
      id: randomUUID(),
      version: 1,
      createdAt: new Date(),
      source: 'arxiv',
      sourceId: entry.arxivId,
      sourceUrl: `https://arxiv.org/abs/${entry.arxivId}`,
      oarxId,
      title: entry.title,
      authors: entry.authors,
      abstract: entry.abstract,
      categories: entry.categories,
      publishedAt: new Date(entry.publishedAt),
      rawContentPath: pdfPath,
      structuredContent: null,
      sources,
      sourceFormat,
      codeLinks: [],
      datasetLinks: [],
      benchmarkResults: [],
      status: 'downloaded',
      processingLog: [],
      processingCost: 0,
      provenance: [],
      externalIds: {
        oarx: oarxId,
        arxiv: entry.arxivId,
        ...(entry.doi ? { doi: entry.doi } : {}),
        ...(entry.journalRef ? { journal_ref: entry.journalRef } : {}),
      },
      retryCount: 0,
      // License from arXiv OAI-PMH (multi-source map + computed effective)
      licenses,
      license: licenseEffective,
      // indexingTier intentionally NOT set here — pipeline gate decides
      // it based on license at processing time. Setting it to 'full' here
      // would short-circuit the gate (which respects existing override).
    };

    await documentStore.save(doc);
    return { document: doc, sourceFormat };
  }

  // ─── E-print download (for latex-upgrade doctor check) ──

  /**
   * Download e-print for an existing paper. Detects LaTeX vs PDF-only.
   * Does NOT create or modify documents — caller handles DB updates.
   */
  async downloadEprint(arxivId: string): Promise<{
    hasLatex: boolean;
    sourcePath?: string;
    rootTex?: string;
    manifest?: boolean;
    texFiles?: number;
  }> {
    const paperDir = arxivDocPath(arxivId, this.dataDir);
    await mkdir(paperDir, { recursive: true });

    const eprintPath = join(paperDir, 'eprint');
    await this.downloadFile(`https://arxiv.org/e-print/${arxivId}`, eprintPath);
    await sleep(RATE_LIMIT_MS);

    const isGzip = await this.isGzipFile(eprintPath);
    if (!isGzip) {
      // e-print is PDF — no LaTeX source
      const { unlink } = await import('node:fs/promises');
      await unlink(eprintPath).catch(() => {});
      return { hasLatex: false };
    }

    // Extract LaTeX source
    const sourceDir = join(paperDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await execFileAsync('tar', ['xzf', eprintPath, '-C', sourceDir]);

    const rootTex = await this.findRootTex(sourceDir);
    const manifest = await this.hasManifest(sourceDir);
    const texFiles = await this.countFiles(sourceDir, '.tex');

    return { hasLatex: true, sourcePath: sourceDir, rootTex: rootTex ?? undefined, manifest, texFiles };
  }

  // ─── Helpers ─────────────────────────────────────────────

  /**
   * Fetch OAI-PMH metadata for an arXiv paper.
   *
   * Returns the raw XML response (for storage as audit trail) and the
   * extracted license string (for normalization). Uses proxy rotation
   * via fetchWithProxy to avoid rate limit issues on the OAI endpoint.
   *
   * Graceful degradation: returns { rawXml: null, license: null } on any
   * error. Never throws — failure to fetch license must not block ingest.
   */
  private async fetchOaiMetadata(arxivId: string): Promise<{
    rawXml: string | null;
    license: string | null;
  }> {
    const url = `https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai:arXiv.org:${arxivId}&metadataPrefix=arXiv`;
    try {
      const resp = await fetchWithProxy(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        log.debug({ arxivId, status: resp.status }, 'OAI-PMH fetch failed');
        return { rawXml: null, license: null };
      }
      const xml = await resp.text();

      // Validate it's a meaningful OAI response (contains arXiv metadata block)
      if (!xml.includes('<arXiv')) {
        return { rawXml: null, license: null };
      }

      // Parse via fast-xml-parser (same parser used elsewhere in this file)
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: true,
      });
      const parsed = parser.parse(xml) as Record<string, unknown>;

      // Path: OAI-PMH > GetRecord > record > metadata > arXiv > license
      const oaiPmh = parsed['OAI-PMH'] as Record<string, unknown> | undefined;
      const getRecord = oaiPmh?.['GetRecord'] as Record<string, unknown> | undefined;
      const record = getRecord?.['record'] as Record<string, unknown> | undefined;
      const metadata = record?.['metadata'] as Record<string, unknown> | undefined;
      const arxivBlock = metadata?.['arXiv'] as Record<string, unknown> | undefined;
      const licenseValue = arxivBlock?.['license'];

      const license = typeof licenseValue === 'string' ? licenseValue.trim() : null;
      return { rawXml: xml, license: license || null };
    } catch (err) {
      log.debug({ arxivId, err: (err as Error).message }, 'OAI-PMH fetch error');
      return { rawXml: null, license: null };
    }
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    // Downloads go THROUGH proxy pool — rotate on 429
    const MAX_DL_RETRIES = 5;
    let resp: Response | undefined;
    for (let attempt = 0; attempt < MAX_DL_RETRIES; attempt++) {
      resp = await fetchWithProxy(url);
      if (resp.ok && resp.body) break;
      if (resp.status === 429) {
        log.debug({ url, attempt }, 'Download 429, rotating proxy');
        continue; // fetchWithProxy already rotated to next proxy
      }
      if (!resp.ok) break; // Non-429 error, don't retry
    }
    if (!resp?.ok || !resp?.body) throw new Error(`Download failed: ${resp?.status ?? 'no response'} ${url}`);
    const ws = createWriteStream(destPath);
    await streamPipeline(
      Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]),
      ws,
    );
  }

  private async isGzipFile(path: string): Promise<boolean> {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path, { flag: 'r' });
    // Gzip magic bytes: 0x1f 0x8b
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  }

  private async findRootTex(dir: string): Promise<string | null> {
    // Try 00README.json manifest first (89% of arXiv archives have it)
    try {
      const { readFile } = await import('node:fs/promises');
      const manifest = JSON.parse(await readFile(join(dir, '00README.json'), 'utf-8'));
      const toplevel = manifest.sources?.find(
        (s: { usage: string; filename: string }) => s.usage === 'toplevel',
      );
      if (toplevel?.filename) return toplevel.filename;
    } catch {
      // No manifest or parse error — use fallback
    }

    // Fallback: grep for \documentclass
    try {
      const { stdout } = await execFileAsync('grep', ['-rl', '\\\\documentclass', dir, '--include=*.tex']);
      const files = stdout.trim().split('\n').filter(Boolean);
      if (files.length > 0) {
        const { basename } = await import('node:path');
        return basename(files[0]);
      }
    } catch {
      // No .tex files found
    }

    return null;
  }

  private async hasManifest(dir: string): Promise<boolean> {
    try {
      await stat(join(dir, '00README.json'));
      return true;
    } catch {
      return false;
    }
  }

  private async countFiles(dir: string, ext: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('find', [dir, '-name', `*${ext}`, '-type', 'f']);
      return stdout.trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }
}
