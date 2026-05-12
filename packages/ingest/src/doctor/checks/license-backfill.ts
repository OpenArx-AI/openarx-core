/**
 * License backfill — fetches license info via arXiv OAI-PMH ListRecords for
 * documents that don't have license info yet (licenses = '{}').
 *
 * Uses ListRecords (batch up to ~1000 records per call) instead of GetRecord
 * (single doc per call). For ~108K documents this takes ~5-10 minutes vs
 * ~90 hours with per-document fetching.
 *
 * Strategy:
 *   1. Walk arXiv OAI-PMH ListRecords with set=cs and resumption token pagination
 *   2. For each record extract arxivId + license, normalize to SPDX
 *   3. UPDATE matching documents in our DB (only those with empty licenses)
 *   4. Documents not in our DB are silently ignored
 *
 * Does NOT touch indexing_tier — existing 108K docs are already fully indexed,
 * downgrading them to abstract_only would discard already-spent processing work.
 */

import { query } from '@openarx/api';
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchWithProxy } from '../../lib/proxy-pool.js';
import { normalizeLicense, computeEffectiveLicense } from '../../lib/license-normalizer.js';
import { arxivDocPath } from '../../utils/doc-path.js';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, DoctorContext, FixResult } from '../types.js';

const log = createChildLogger('doctor:license-backfill');
const OAI_URL = 'https://oaipmh.arxiv.org/oai';
const RATE_LIMIT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface OaiRecord {
  arxivId: string;
  licenseRaw: string | null;
  rawXml: string;  // The full <record>...</record> XML chunk for this doc
}

/**
 * Fetch one ListRecords page from arXiv OAI-PMH.
 * Returns extracted records and the next resumption token (or null when done).
 *
 * On first call (resumptionToken null), `fromDate` and optional `untilDate`
 * limit the harvest. Subsequent calls use the resumption token which already
 * encodes these constraints internally.
 */
async function fetchListRecordsPage(
  resumptionToken: string | null,
  fromDate: string | null = null,
  untilDate: string | null = null,
): Promise<{ records: OaiRecord[]; nextToken: string | null }> {
  let url: string;
  if (resumptionToken) {
    url = `${OAI_URL}?verb=ListRecords&resumptionToken=${encodeURIComponent(resumptionToken)}`;
  } else {
    const params = new URLSearchParams({
      verb: 'ListRecords',
      metadataPrefix: 'arXiv',
      set: 'cs',
    });
    if (fromDate) params.set('from', fromDate);
    if (untilDate) params.set('until', untilDate);
    url = `${OAI_URL}?${params.toString()}`;
  }

  log.debug({ url, hasResumptionToken: !!resumptionToken }, '[license-backfill] fetching OAI page');

  const resp = await fetchWithProxy(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    throw new Error(`OAI ListRecords HTTP ${resp.status}`);
  }
  const xml = await resp.text();

  // Check for OAI-PMH error response
  if (xml.includes('<error code=')) {
    const match = xml.match(/<error code="([^"]+)"[^>]*>([^<]*)<\/error>/);
    const code = match?.[1] ?? 'unknown';
    const msg = match?.[2] ?? '';
    throw new Error(`OAI-PMH error: ${code} ${msg}`);
  }

  // Parse for license + arxivId, but keep raw XML chunks for disk storage.
  // We use regex to slice individual <record>...</record> blocks (XMLParser
  // discards original formatting); inside each block we use XMLParser to
  // extract id + license cleanly.
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });

  const records: OaiRecord[] = [];
  // Match each <record>...</record> block (greedy stop at first </record>)
  const recordRegex = /<record>([\s\S]*?)<\/record>/g;
  let match: RegExpExecArray | null;
  while ((match = recordRegex.exec(xml)) !== null) {
    const rawXml = match[0];
    try {
      const parsed = parser.parse(rawXml) as Record<string, unknown>;
      const rec = parsed['record'] as Record<string, unknown> | undefined;
      const meta = rec?.['metadata'] as Record<string, unknown> | undefined;
      const arxivBlock = meta?.['arXiv'] as Record<string, unknown> | undefined;
      if (!arxivBlock) continue;

      const idValue = arxivBlock['id'];
      const arxivId = typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : '';
      if (!arxivId) continue;

      const licenseValue = arxivBlock['license'];
      const licenseRaw = typeof licenseValue === 'string' ? licenseValue.trim() : null;
      records.push({ arxivId, licenseRaw: licenseRaw || null, rawXml });
    } catch {
      // skip malformed record
    }
  }

  // Resumption token via simpler regex to avoid full re-parse
  let nextToken: string | null = null;
  const tokenMatch = xml.match(/<resumptionToken[^>]*>([^<]*)<\/resumptionToken>/);
  if (tokenMatch && tokenMatch[1]) {
    nextToken = tokenMatch[1];
  }

  return { records, nextToken };
}

type UpdateOutcome =
  | 'updated'              // DB row was updated (licenses were empty before)
  | 'updated_disk_only'    // DB already had license, but disk files were missing — wrote them
  | 'fully_consistent'     // DB has license AND disk has all files — nothing to do
  | 'not_in_db';           // No document with this source_id exists in our DB

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Persist OAI XML chunk + license info to disk. Idempotent and selective:
 * only writes files that are missing or incomplete.
 *
 * Returns true if any file was actually written/modified.
 *
 * Failures are logged but don't abort backfill.
 */
async function persistOaiToDisk(
  arxivId: string,
  rawXml: string,
  licenseRaw: string | null,
  spdx: string,
): Promise<boolean> {
  const paperDir = arxivDocPath(arxivId);
  let modified = false;
  try {
    await mkdir(paperDir, { recursive: true });

    // 1. oai_arxiv.xml — write if missing
    const oaiPath = join(paperDir, 'oai_arxiv.xml');
    if (!(await fileExists(oaiPath))) {
      await writeFile(oaiPath, rawXml, 'utf-8');
      modified = true;
    }

    // 2. metadata.json — read, check if license.arxiv_oai block exists, add if not
    const metaPath = join(paperDir, 'metadata.json');
    let metaObj: Record<string, unknown> = {};
    let metaExists = false;
    try {
      const existing = await readFile(metaPath, 'utf-8');
      metaObj = JSON.parse(existing) as Record<string, unknown>;
      metaExists = true;
    } catch {
      metaObj = { arxivId };
    }

    const existingLicense = metaObj['license'] as Record<string, unknown> | undefined;
    const hasArxivOai = existingLicense && typeof existingLicense === 'object' && 'arxiv_oai' in existingLicense;

    if (!metaExists || !hasArxivOai) {
      metaObj['license'] = {
        ...(existingLicense ?? {}),
        arxiv_oai: {
          spdx,
          raw: licenseRaw,
        },
      };
      await writeFile(metaPath, JSON.stringify(metaObj, null, 2), 'utf-8');
      modified = true;
    }

    return modified;
  } catch (err) {
    log.warn({
      arxivId,
      paperDir,
      err: err instanceof Error ? err.message : String(err),
    }, '[license-backfill] disk persist failed (non-critical)');
    return false;
  }
}

/**
 * Process a single OAI record: ensure DB and disk are both consistent with the
 * license info from arXiv OAI-PMH. Idempotent — multiple runs converge.
 *
 * Behavior:
 * 1. If document doesn't exist in our DB → 'not_in_db'
 * 2. If DB licenses are empty → UPDATE DB + persist to disk → 'updated'
 * 3. If DB has license already → check disk, persist anything missing
 *    - if anything was written → 'updated_disk_only'
 *    - if everything already in place → 'fully_consistent'
 */
async function updateDocumentLicense(
  arxivId: string,
  licenseRaw: string | null,
  rawXml: string,
): Promise<UpdateOutcome> {
  const info = normalizeLicense(licenseRaw);
  const licenses: Record<string, string> = {};
  if (info.spdx !== 'NOASSERTION') {
    licenses.arxiv_oai = info.spdx;
  }
  const effective = computeEffectiveLicense(licenses);

  // Try to UPDATE only if licenses are empty
  const result = await query(
    `UPDATE documents
       SET licenses = $1::jsonb,
           license = $2
     WHERE source = 'arxiv' AND source_id = $3 AND licenses = '{}'::jsonb`,
    [JSON.stringify(licenses), effective, arxivId],
  );
  if ((result.rowCount ?? 0) > 0) {
    // DB updated — also persist to disk
    await persistOaiToDisk(arxivId, rawXml, licenseRaw, info.spdx);
    log.debug({
      arxivId,
      licenseRaw,
      spdx: info.spdx,
      effective,
    }, '[license-backfill] document updated (DB + disk)');
    return 'updated';
  }

  // No DB row updated — either doc doesn't exist OR already has license
  const check = await query<{ exists: boolean }>(
    `SELECT true as exists FROM documents
      WHERE source = 'arxiv' AND source_id = $1 LIMIT 1`,
    [arxivId],
  );
  if (check.rowCount === 0) {
    return 'not_in_db';
  }

  // Doc exists in DB with license already set — check disk consistency
  const diskModified = await persistOaiToDisk(arxivId, rawXml, licenseRaw, info.spdx);
  if (diskModified) {
    log.debug({
      arxivId,
      spdx: info.spdx,
    }, '[license-backfill] disk files added (DB already had license)');
    return 'updated_disk_only';
  }

  return 'fully_consistent';
}

export function createLicenseBackfillCheck(ctx: DoctorContext): CheckModule {
  return {
    name: 'license-backfill',
    description: 'arXiv documents missing license info (licenses = {})',
    severity: 'medium',

    async detect(): Promise<CheckResult> {
      const result = await query<{ cnt: string }>(
        `SELECT count(*)::text as cnt FROM documents
          WHERE source = 'arxiv' AND licenses = '{}'::jsonb`,
      );
      const count = parseInt(result.rows[0]?.cnt ?? '0', 10);
      if (count === 0) {
        return { status: 'ok', message: 'All arxiv docs have license info', affectedCount: 0 };
      }
      return {
        status: 'warn',
        message: `${count} arxiv docs missing license info — need OAI-PMH backfill`,
        affectedCount: count,
      };
    },

    async fix(): Promise<FixResult> {
      let totalUpdated = 0;
      let totalUpdatedDiskOnly = 0;
      let totalFullyConsistent = 0;
      let totalNotInDb = 0;
      let totalFailed = 0;
      let totalSeen = 0;
      let token: string | null = null;
      let pages = 0;
      const limit = ctx.fixLimit;

      // Determine date range for OAI harvest.
      // Strategy: skip outlier months (where we have < 100 docs) — they tail
      // the from-date deep into the past and force us to walk through years
      // of empty pages. The few outliers can be handled separately if needed.
      // untilDate caps at latest published_at to avoid future records.
      const dateRangeResult = await query<{ from_date: string | null; until_date: string | null }>(
        `WITH monthly AS (
          SELECT date_trunc('month', published_at)::date as month, count(*) as cnt
            FROM documents
           WHERE source = 'arxiv' AND licenses = '{}'::jsonb
           GROUP BY 1
        )
        SELECT
          (SELECT min(month)::text FROM monthly WHERE cnt >= 100) as from_date,
          (SELECT max(published_at)::date::text FROM documents
            WHERE source = 'arxiv' AND licenses = '{}'::jsonb) as until_date`,
      );
      const fromDate = dateRangeResult.rows[0]?.from_date ?? null;
      const untilDate = dateRangeResult.rows[0]?.until_date ?? null;

      log.info({
        limit: limit ?? 'unlimited',
        from_date: fromDate,
        until_date: untilDate,
      }, '[license-backfill] starting OAI-PMH ListRecords backfill');

      while (true) {
        try {
          const { records, nextToken } = await fetchListRecordsPage(token, fromDate, untilDate);
          pages++;

          for (const rec of records) {
            totalSeen++;
            try {
              const outcome = await updateDocumentLicense(rec.arxivId, rec.licenseRaw, rec.rawXml);
              if (outcome === 'updated') totalUpdated++;
              else if (outcome === 'updated_disk_only') totalUpdatedDiskOnly++;
              else if (outcome === 'fully_consistent') totalFullyConsistent++;
              else if (outcome === 'not_in_db') totalNotInDb++;
            } catch (err) {
              totalFailed++;
              log.warn({
                arxivId: rec.arxivId,
                err: err instanceof Error ? err.message : String(err),
              }, '[license-backfill] update failed');
            }
            // Stop limit applies to actual DB updates only (not disk-only fixes)
            if (limit && totalUpdated >= limit) break;
          }

          log.info({
            page: pages,
            records_in_page: records.length,
            total_seen: totalSeen,
            total_updated: totalUpdated,
            total_updated_disk_only: totalUpdatedDiskOnly,
            total_fully_consistent: totalFullyConsistent,
            total_not_in_db: totalNotInDb,
            total_failed: totalFailed,
            has_next_token: !!nextToken,
          }, '[license-backfill] page processed');

          if (limit && totalUpdated >= limit) {
            log.info({ limit, totalUpdated }, '[license-backfill] reached fixLimit, stopping');
            break;
          }

          if (!nextToken) {
            log.info('[license-backfill] no more resumption tokens, backfill complete');
            break;
          }

          token = nextToken;
          await sleep(RATE_LIMIT_MS);
        } catch (err) {
          log.error({
            err: err instanceof Error ? err.message : String(err),
            pages,
            totalSeen,
            totalUpdated,
          }, '[license-backfill] page fetch failed, aborting');
          totalFailed++;
          break;
        }
      }

      return {
        fixed: totalUpdated + totalUpdatedDiskOnly,
        failed: totalFailed,
        message: `Backfilled: ${totalUpdated} DB+disk, ${totalUpdatedDiskOnly} disk-only, ${totalFullyConsistent} already consistent, ${totalNotInDb} not in DB (${totalSeen} seen, ${pages} pages)`,
      };
    },
  };
}
