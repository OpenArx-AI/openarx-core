/**
 * Single-document enrichment function — the core of the enrichment worker.
 *
 * For one document: resolve DOI → query all 4 sources in parallel →
 * download files → save locations to DB → update licenses → trigger re-index if needed.
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D2–D6, D11)
 */

import { query } from '@openarx/api';
import { normalizeLicense, isOpenLicense, computeEffectiveLicense } from '@openarx/ingest';
import { createChildLogger } from './logger.js';

const log = createChildLogger('enrich');
import type { OpenAlexClient, OpenAlexResult } from '../sources/openalex.js';
import type { UnpaywallClient, UnpaywallResult } from '../sources/unpaywall.js';
import type { CoreClient, CoreResult } from '../sources/core.js';
import type { PmcClient, PmcResult } from '../sources/pmc.js';
import type { RateLimiter } from './rate-limiter.js';
import { DailyQuotaExhaustedError } from './rate-limiter.js';
import type { DocumentSelection } from './selection.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────

export interface EnrichDeps {
  openalex: OpenAlexClient;
  unpaywall: UnpaywallClient;
  core: CoreClient;
  pmc: PmcClient;
  rateLimiter: RateLimiter;
  dataDir: string;
}

export interface EnrichResult {
  documentId: string;
  status: 'enriched' | 'no_doi' | 'error';
  locationsFound: number;
  filesDownloaded: number;
  licensesAdded: string[];
  reindexTriggered: boolean;
}

export interface OaLocation {
  source: string;
  url: string;
  license: string | null;
  version: string | null;
  hostType: string | null;
}

// ── Aggregation (pure) ──────────────────────────────────────

/** Skip URLs pointing back to arxiv — we already have the canonical file. */
function isArxivUrl(url: string): boolean {
  return url.includes('arxiv.org/') || url.includes('doi.org/10.48550/arxiv');
}

export function aggregateLocations(
  openalex: OpenAlexResult | null,
  unpaywall: UnpaywallResult | null,
  core: CoreResult | null,
  pmc: PmcResult | null,
): OaLocation[] {
  const locations: OaLocation[] = [];

  if (openalex?.status === 'success') {
    for (const loc of openalex.locations) {
      if (loc.isOa && loc.pdfUrl && !isArxivUrl(loc.pdfUrl)) {
        locations.push({
          source: 'openalex',
          url: loc.pdfUrl,
          license: loc.license,
          version: loc.version,
          hostType: loc.sourceType,
        });
      }
    }
  }

  if (unpaywall?.status === 'success' && unpaywall.isOa) {
    for (const loc of unpaywall.allLocations) {
      const url = loc.urlForPdf ?? loc.url;
      if (url && !isArxivUrl(url)) {
        locations.push({
          source: 'unpaywall',
          url,
          license: loc.license,
          version: loc.version,
          hostType: loc.hostType,
        });
      }
    }
  }

  if (core?.status === 'success') {
    for (const loc of core.locations) {
      const url = loc.downloadUrl ?? loc.sourceFulltextUrls[0];
      if (url && !isArxivUrl(url)) {
        locations.push({
          source: 'core',
          url,
          license: loc.license,
          version: null,
          hostType: 'repository',
        });
      }
    }
  }

  if (pmc?.status === 'success' && pmc.pdfUrl) {
    locations.push({
      source: 'pmc',
      url: pmc.pdfUrl,
      license: pmc.license,
      version: null,
      hostType: 'repository',
    });
  }

  return locations;
}

// ── File download ───────────────────────────────────────────

function arxivDocPath(arxivId: string, dataDir: string): string {
  const parts = arxivId.split('.');
  if (parts.length === 2) {
    const yy = parts[0].slice(0, 2);
    const mm = parts[0].slice(2, 4);
    return join(dataDir, yy, mm, arxivId);
  }
  return join(dataDir, 'legacy', arxivId.replace('/', '_'));
}

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const DOWNLOAD_TIMEOUT_MS = 60_000;

async function downloadToAlt(
  arxivId: string,
  source: string,
  url: string,
  dataDir: string,
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'User-Agent': 'OpenArx Research Indexer (https://openarx.com; hello@openarx.ai)' },
      redirect: 'follow',
    });

    if (!resp.ok || !resp.body) return null;

    const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10);
    if (contentLength > MAX_FILE_SIZE) return null;

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_FILE_SIZE) return null;
    if (buffer.length === 0) return null;

    // Determine filename from URL or content-disposition
    const urlPath = new URL(url).pathname;
    const urlFilename = urlPath.split('/').pop() || 'document';
    const ext = urlFilename.includes('.') ? '' : '.pdf';
    const filename = urlFilename + ext;

    const altDir = join(arxivDocPath(arxivId, dataDir), 'alt', source);
    await mkdir(altDir, { recursive: true });
    const filePath = join(altDir, filename);
    await writeFile(filePath, buffer);

    return filePath;
  } catch {
    return null; // Download failure is non-critical
  }
}

// ── DB helpers ──────────────────────────────────────────────

async function insertDocumentLocation(
  documentId: string,
  loc: OaLocation,
  licenseSpdx: string,
  filePath: string | null,
): Promise<void> {
  await query(
    `INSERT INTO document_locations
       (document_id, source_id, source_url, license_raw, license_canonical,
        version, host_type, is_oa, is_primary, file_path, fetched_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, false, $8, now(), now())`,
    [documentId, loc.source, loc.url, loc.license, licenseSpdx,
     loc.version, loc.hostType, filePath],
  );
}

/**
 * Merge new license discoveries into the existing per-source map, preferring
 * the most permissive (open) value when the same source is reported with
 * different licenses across enrichment passes.
 *
 * Pre-fix (2026-05-04, openarx-hjpg follow-up): merge was first-write-wins —
 * if the first unpaywall lookup returned `CC-BY-NC-4.0` and a later lookup
 * returned `CC-BY-4.0`, the closed value stuck. That hid the open copy from
 * `computeEffectiveLicense` and prevented full-tier promotion.
 */
export function mergeLicenseSources(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const merged = { ...existing };
  for (const [source, spdx] of Object.entries(incoming)) {
    const prior = merged[source];
    if (!prior) {
      merged[source] = spdx;
    } else if (isOpenLicense(spdx) && !isOpenLicense(prior)) {
      merged[source] = spdx;
    }
  }
  return merged;
}

/**
 * Decide whether enricher should reset a document for full re-indexing.
 *
 * Pre-fix (2026-05-04): the only conditions were `indexingTier === 'abstract_only'`
 * and `filesDownloaded > 0`. That fired even when every downloaded location was
 * still under a closed license, causing wasteful re-runs through the same
 * abstract-only route. Live audit on prod found 3/14 reset cases were closed-
 * license docs (CC-BY-NC-ND, arxiv-nonexclusive) — all reprocessed back to
 * abstract_only without benefit.
 *
 * The runner picks tier from `documents.license` via `computeIndexingTier`, so
 * unless the effective license has flipped to open, re-indexing yields the
 * same single abstract chunk we already had.
 */
export function shouldTriggerReindex(
  indexingTier: string | null,
  filesDownloaded: number,
  effectiveLicense: string,
): boolean {
  if (indexingTier !== 'abstract_only') return false;
  if (filesDownloaded === 0) return false;
  if (!isOpenLicense(effectiveLicense)) return false;
  return true;
}

async function updateDocumentLicenses(
  documentId: string,
  newSources: Record<string, string>,
): Promise<{ effective: string }> {
  // Read current licenses
  const current = await query<{ licenses: Record<string, string> }>(
    `SELECT licenses FROM documents WHERE id = $1`,
    [documentId],
  );
  if (current.rows.length === 0) {
    return { effective: 'NOASSERTION' };
  }

  const row = current.rows[0];
  const existingLicenses = (typeof row.licenses === 'object' && row.licenses !== null)
    ? row.licenses as Record<string, string>
    : {};

  const merged = mergeLicenseSources(existingLicenses, newSources);

  const effective = computeEffectiveLicense(merged);

  // Update licenses + effective
  await query(
    `UPDATE documents SET licenses = $1::jsonb, license = $2 WHERE id = $3`,
    [JSON.stringify(merged), effective, documentId],
  );

  return { effective };
}

/**
 * Trigger re-indexing: set status='downloaded' + indexing_tier=NULL so runner
 * picks up the document via direction='pending_only' and re-processes through
 * full pipeline. Condition (post-2026-05-04 fix): document was abstract_only
 * AND we downloaded at least one file AND the effective license has flipped
 * to OPEN (otherwise re-running just re-emits the abstract chunk).
 */
async function triggerReindexIfNeeded(
  documentId: string,
  indexingTier: string | null,
  filesDownloaded: number,
  effectiveLicense: string,
): Promise<boolean> {
  if (!shouldTriggerReindex(indexingTier, filesDownloaded, effectiveLicense)) return false;

  const result = await query(
    `UPDATE documents SET status = 'downloaded', indexing_tier = NULL
      WHERE id = $1 AND indexing_tier = 'abstract_only'`,
    [documentId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertEnrichmentAttempt(
  documentId: string,
  sourcesTried: string[],
  oaFoundCount: number,
  status: string,
  responseSummary: unknown,
): Promise<void> {
  const cooldownDays = status === 'success_oa' ? 90 : status === 'no_doi' ? 14 : 14;
  await query(
    `INSERT INTO enrichment_attempts
       (document_id, sources_tried, oa_found_count, status, response_summary, next_retry_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '${cooldownDays} days')`,
    [documentId, sourcesTried, oaFoundCount, status, JSON.stringify(responseSummary ?? {})],
  );
}

// ── Main function ───────────────────────────────────────────

export async function enrichDocument(
  doc: DocumentSelection,
  deps: EnrichDeps,
): Promise<EnrichResult> {
  const { documentId, sourceId: arxivId, doi } = doc;

  const startMs = Date.now();
  log.debug({ documentId, arxivId, doi, indexingTier: doc.indexingTier }, 'start');

  // Step 1: DOI check
  if (!doi) {
    log.debug({ documentId, arxivId }, 'no_doi — skipping');
    await insertEnrichmentAttempt(documentId, [], 0, 'no_doi', null);
    return {
      documentId, status: 'no_doi',
      locationsFound: 0, filesDownloaded: 0, licensesAdded: [], reindexTriggered: false,
    };
  }

  // Step 2: Rate limit — acquire per-source, skip if quota exhausted
  const sourceEnabled: Record<string, boolean> = {};
  for (const source of ['openalex', 'unpaywall', 'core', 'pmc']) {
    try {
      await deps.rateLimiter.acquire(source);
      sourceEnabled[source] = true;
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) {
        log.warn({ source, documentId }, 'quota exhausted — skipping source for this doc');
        sourceEnabled[source] = false;
      } else {
        throw err;
      }
    }
  }

  // Step 3: Query enabled sources in parallel (D2: all parallel by DOI)
  const [openalexResult, unpaywallResult, coreResult, pmcResult] = await Promise.all([
    sourceEnabled['openalex']
      ? deps.openalex.lookupByDoi(doi).catch((err): OpenAlexResult | null => {
          if (err.name === 'AuthError') throw err;
          return null;
        })
      : Promise.resolve(null as OpenAlexResult | null),
    sourceEnabled['unpaywall']
      ? deps.unpaywall.lookup(doi).catch((err): UnpaywallResult | null => {
          if (err.name === 'AuthError') throw err;
          return null;
        })
      : Promise.resolve(null as UnpaywallResult | null),
    sourceEnabled['core']
      ? deps.core.lookup(doi).catch((err): CoreResult | null => {
          if (err.name === 'AuthError') throw err;
          return null;
        })
      : Promise.resolve(null as CoreResult | null),
    sourceEnabled['pmc']
      ? deps.pmc.lookup(doi).catch((err): PmcResult | null => {
          if (err.name === 'AuthError') throw err;
          return null;
        })
      : Promise.resolve(null as PmcResult | null),
  ]);

  log.debug({
    doi,
    openalex: openalexResult?.status ?? 'error',
    unpaywall: unpaywallResult?.status ?? 'error',
    core: coreResult?.status ?? 'error',
    pmc: pmcResult?.status ?? 'error',
  }, 'sources_queried');

  // Step 3: Aggregate OA locations
  const locations = aggregateLocations(openalexResult, unpaywallResult, coreResult, pmcResult);
  log.debug({ doi, totalLocations: locations.length, bySource: locations.reduce((acc, l) => { acc[l.source] = (acc[l.source] ?? 0) + 1; return acc; }, {} as Record<string, number>) }, 'aggregated');

  // Step 4: Download files + save locations to DB
  let filesDownloaded = 0;
  const licensesAdded: string[] = [];
  const newLicenseSources: Record<string, string> = {};

  for (const loc of locations) {
    // Normalize license
    const info = normalizeLicense(loc.license);

    // Download file (D5: always, any license)
    log.debug({ arxivId, source: loc.source, url: loc.url.slice(0, 100) }, 'download_start');
    const filePath = await downloadToAlt(arxivId, loc.source, loc.url, deps.dataDir);
    if (filePath) {
      filesDownloaded++;
      log.debug({ arxivId, source: loc.source, filePath }, 'download_ok');
    } else {
      log.warn({ arxivId, source: loc.source, url: loc.url.slice(0, 100) }, 'download_fail');
    }

    // Save to document_locations
    await insertDocumentLocation(documentId, loc, info.spdx, filePath);

    // Collect license for documents.licenses update.
    // If file downloaded, record the source even when SPDX is NOASSERTION —
    // a servable OA copy without explicit license is treated as open
    // (permissive default; absence of explicit license interpreted in our favor).
    if (!newLicenseSources[loc.source] && (filePath || info.spdx !== 'NOASSERTION')) {
      newLicenseSources[loc.source] = info.spdx;
      licensesAdded.push(`${loc.source}:${info.spdx}`);
    }
  }

  // Step 5a: Update documents.licenses if we found any new license info.
  // Capture the resulting effective license — needed by the reindex check
  // to confirm the doc actually flipped to open. If no new sources surfaced,
  // read the current effective directly so step 5b still has a value.
  let effective: string;
  if (Object.keys(newLicenseSources).length > 0) {
    const result = await updateDocumentLicenses(documentId, newLicenseSources);
    effective = result.effective;
    log.debug({ documentId, newEffective: effective, licensesAdded }, 'licenses_updated');
  } else {
    const { rows } = await query<{ license: string | null }>(
      `SELECT license FROM documents WHERE id = $1`,
      [documentId],
    );
    effective = rows[0]?.license ?? 'NOASSERTION';
  }

  // Step 5b: Trigger full re-indexing only when the doc flipped to OPEN —
  // otherwise the runner re-runs through the same abstract_only route
  // (computeIndexingTier still resolves to 'abstract_only' for closed
  // licenses) and wastes work.
  const reindexTriggered = await triggerReindexIfNeeded(documentId, doc.indexingTier, filesDownloaded, effective);
  if (reindexTriggered) {
    log.info({ documentId, arxivId, filesDownloaded, effective }, 'reindex_triggered — abstract_only doc became open');
  }

  // Step 6: Record enrichment attempt (D4: global, 1 row)
  const sourcesTried = ['openalex', 'unpaywall', 'core', 'pmc'];
  const attemptStatus = locations.length > 0 ? 'success_oa' : 'success_no_oa';
  await insertEnrichmentAttempt(documentId, sourcesTried, locations.length, attemptStatus, {
    openalex: openalexResult?.status ?? 'error',
    unpaywall: unpaywallResult?.status ?? 'error',
    core: coreResult?.status ?? 'error',
    pmc: pmcResult?.status ?? 'error',
    locationsFound: locations.length,
    filesDownloaded,
  });

  const durationMs = Date.now() - startMs;
  log.info({ documentId, arxivId, status: 'enriched', locationsFound: locations.length, filesDownloaded, reindexTriggered, durationMs }, 'complete');

  return {
    documentId,
    status: 'enriched',
    locationsFound: locations.length,
    filesDownloaded,
    licensesAdded,
    reindexTriggered,
  };
}
