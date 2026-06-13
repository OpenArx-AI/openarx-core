/**
 * POST /api/internal/publish-document — unified document publication endpoint
 * (contract document_publication_pipeline.md, bead openarx-contracts-uhlh).
 *
 * One Core-owned path for both Portal UI (caller=portal) and MCP agents
 * (caller=mcp). Owns: caller discrimination, consent verification, license
 * SPDX normalization, Aspect-1 spam screening (sync), atomic staged storage,
 * document save + idempotency, and enqueue for the async Aspect 2–4 pipeline.
 *
 * Phase 1 (this file): caller=portal end-to-end; caller=mcp implemented but
 * fail-closed to 503 until Portal ships /api/internal/user-consent-state
 * (contract §4 — "branch goes live without Core re-deploy").
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, cp, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep } from 'node:path';
import type { Request, Response } from 'express';
import type { AppContext } from './context.js';
import type { Author, CodeLink, DatasetLink, BenchmarkResult, Document } from '@openarx/types';
import { query, computeOarxId } from '@openarx/api';
import { normalizeLicense, runSpamScreen, type SpamScreenResult } from '@openarx/ingest';
import { createInitialReview } from '@openarx/api';
import { getRequiredVersions, getLegalVersionsError, type LegalVersions } from './lib/legal-versions.js';

const PORTAL_STORAGE_BASE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';
const PORTAL_INTERNAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://localhost:3200';
const INTERNAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';
const CONSENT_RECENCY_MS = 10 * 60 * 1000; // §4: 10-minute anti-replay window
const CONSENT_KEYS: (keyof LegalVersions)[] = [
  'tos_version', 'privacy_version', 'dmca_version', 'upload_consent_version',
];

// Size ceilings — mirror the MCP zod schemas (bead 6vz2) so both entry
// points reject identically.
const LIMITS = { title: 5_000, abstract: 50_000, contentText: 2_000_000, keywordsMax: 50, keywordItemMax: 100 };

// ── Pure, unit-tested helpers ────────────────────────────────────────────

export function parseCaller(header: unknown): 'portal' | 'mcp' | null {
  return header === 'portal' || header === 'mcp' ? header : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** user_id must be a real UUID — it becomes a filesystem path segment, so a
 *  value like '../../etc' would otherwise escape PORTAL_STORAGE_BASE. */
export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === 'string' && UUID_RE.test(userId);
}

/** Reject relative paths that escape (`..` segment) or are absolute. Used on
 *  the client-supplied main_file before it is joined into any path. */
export function isUnsafeRelPath(p: string): boolean {
  if (p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)) return true;
  return p.split(/[/\\]/).some((s) => s === '..');
}

/** "v1.2" → [1,2]; tolerant of missing minor / leading v. */
export function parseVersion(v: string): [number, number] {
  const m = /^v?(\d+)(?:\.(\d+))?/.exec(v.trim());
  return m ? [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] : [-1, -1];
}

/** ≥ comparison: is `have` at least `required`? */
export function versionAtLeast(have: string, required: string): boolean {
  const [hM, hm] = parseVersion(have);
  const [rM, rm] = parseVersion(required);
  return hM > rM || (hM === rM && hm >= rm);
}

export interface ConsentBlock {
  tos_version?: string; privacy_version?: string;
  dmca_version?: string; upload_consent_version?: string;
  accepted_at?: string;
}

/**
 * caller=portal: every version must EQUAL the current required version, and
 * accepted_at must be within the recency window (set by Portal at forward
 * time). Returns the list of missing/stale keys (empty = ok).
 */
export function verifyPortalConsent(
  consent: ConsentBlock | undefined,
  required: LegalVersions,
  nowMs: number,
): string[] {
  if (!consent) return [...CONSENT_KEYS];
  const stale: string[] = CONSENT_KEYS.filter((k) => consent[k] !== required[k]);
  const acceptedMs = consent.accepted_at ? Date.parse(consent.accepted_at) : NaN;
  if (Number.isNaN(acceptedMs) || nowMs - acceptedMs > CONSENT_RECENCY_MS || acceptedMs - nowMs > CONSENT_RECENCY_MS) {
    if (!stale.includes('accepted_at')) stale.push('accepted_at');
  }
  return stale;
}

/** caller=mcp: account-level versions must be ≥ required (newer is fine). */
export function verifyAccountConsent(
  state: ConsentBlock | undefined,
  required: LegalVersions,
): string[] {
  if (!state) return [...CONSENT_KEYS];
  return CONSENT_KEYS.filter((k) => {
    const have = state[k];
    return typeof have !== 'string' || !versionAtLeast(have, required[k]);
  });
}

/** Aspect 1 fail-open marker (contract §5): LLM timeout / upstream down. */
export function isAspect1ProviderFailure(result: SpamScreenResult): boolean {
  return result.reasons.some(
    (r) => r.code === 'LLM_TIMEOUT' || r.code === 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE',
  );
}

/** Required-field + size validation shared by both callers. Returns message or null. */
export function validatePublishBody(body: Record<string, unknown>): string | null {
  const title = body.title as string | undefined;
  const abstract = body.abstract as string | undefined;
  const contentFormat = body.content_format as string | undefined;
  const contentSource = body.content_source as Record<string, unknown> | undefined;
  const license = body.license as string | undefined;
  const authors = body.authors as unknown[] | undefined;

  if (!title || !abstract || !contentFormat || !contentSource || !license || !authors?.length) {
    return 'Required fields: user_id, title, abstract, authors (≥1), content_format, content_source, license';
  }
  if (!['latex', 'markdown', 'pdf'].includes(contentFormat)) {
    return 'content_format must be latex, markdown, or pdf';
  }
  if (title.length > LIMITS.title) return `title exceeds ${LIMITS.title} chars`;
  if (abstract.length > LIMITS.abstract) return `abstract exceeds ${LIMITS.abstract} chars`;
  const text = (contentSource.text as string | undefined);
  if (typeof text === 'string' && text.length > LIMITS.contentText) {
    return `content_source.text exceeds ${LIMITS.contentText} chars`;
  }
  const keywords = body.keywords as string[] | undefined;
  if (keywords) {
    if (keywords.length > LIMITS.keywordsMax) return `keywords exceeds ${LIMITS.keywordsMax} items`;
    if (keywords.some((k) => typeof k === 'string' && k.length > LIMITS.keywordItemMax)) {
      return `a keyword exceeds ${LIMITS.keywordItemMax} chars`;
    }
  }
  return null;
}

// ── Route handler ─────────────────────────────────────────────────────────

function jres(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status).json(body);
}

export async function handlePublishDocument(req: Request, res: Response, ctx: AppContext): Promise<void> {
  // §2: X-Caller required, validated before anything else.
  const caller = parseCaller(req.headers['x-caller']);
  if (!caller) {
    jres(res, 400, { ok: false, error: 'validation_error', message: "X-Caller header required: 'portal' or 'mcp'" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const bodyError = validatePublishBody(body);
  if (bodyError) {
    jres(res, 400, { ok: false, error: 'validation_error', message: bodyError });
    return;
  }

  // §3 amendment + security: user_id required and must be a UUID. It becomes
  // a path segment ({BASE}/{userId}/{docId}), so anything but a UUID
  // (incl. _anonymous/_core or a traversal string) is rejected before any
  // path construction.
  const userId = body.user_id;
  if (!isValidUserId(userId)) {
    jres(res, 400, { ok: false, error: 'user_required', message: 'A resolvable user_id (UUID) is required to publish' });
    return;
  }

  // §4/§11: required versions from the shared legal-versions file. Missing /
  // malformed file → fail-closed (cannot verify consent → cannot publish).
  const required = getRequiredVersions();
  if (!required) {
    jres(res, 503, { ok: false, error: 'consent_check_unavailable', message: `legal-versions unavailable: ${getLegalVersionsError() ?? 'unknown'}` });
    return;
  }

  // ── Consent verification (branches by caller) ──
  if (caller === 'portal') {
    const stale = verifyPortalConsent(body.consent as ConsentBlock | undefined, required, Date.now());
    if (stale.length > 0) {
      jres(res, 400, {
        ok: false, error: 'consent_required',
        missing_or_stale: stale,
        current_required_versions: required,
      });
      return;
    }
  } else {
    // caller=mcp: verify account-level consent via Portal. Unreachable / non-OK
    // → 503 fail-closed (Phase 1: Portal endpoint not shipped → always 503).
    let state: ConsentBlock | undefined;
    try {
      const resp = await fetch(
        `${PORTAL_INTERNAL_URL}/api/internal/user-consent-state?user_id=${encodeURIComponent(userId)}`,
        { headers: { 'X-Internal-Secret': INTERNAL_SECRET }, signal: AbortSignal.timeout(5_000) },
      );
      if (!resp.ok) {
        jres(res, 503, { ok: false, error: 'consent_check_unavailable', message: `Portal consent-state returned ${resp.status}` });
        return;
      }
      state = await resp.json() as ConsentBlock;
    } catch (err) {
      jres(res, 503, { ok: false, error: 'consent_check_unavailable', message: `Portal consent-state unreachable: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const stale = verifyAccountConsent(state, required);
    if (stale.length > 0) {
      jres(res, 400, {
        ok: false, error: 'account_consent_required',
        message: 'User must re-accept upload consent at portal.openarx.ai/portal/consent',
        user_accept_url: 'https://portal.openarx.ai/portal/consent',
        missing_or_stale: stale,
        current_required_versions: required,
      });
      return;
    }
  }

  // ── §8: idempotency pre-check ──
  const idempotencyKey = body.idempotency_key as string | undefined;
  if (idempotencyKey) {
    const existing = await query<{ id: string; oarx_id: string | null; status: string }>(
      `SELECT id, oarx_id, status FROM documents
        WHERE publisher_user_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
      [userId, idempotencyKey],
    );
    if (existing.rows[0]) {
      const r = existing.rows[0];
      jres(res, 409, { ok: true, core_document_id: r.id, oarx_id: r.oarx_id, status: r.status, idempotent_replay: true });
      return;
    }
  }

  const contentFormat = body.content_format as 'latex' | 'markdown' | 'pdf';
  const title = body.title as string;
  const abstract = body.abstract as string;
  const contentSource = body.content_source as Record<string, unknown>;

  // ── §5 Aspect 1: spam screen (sync, 3s hard cap inside runSpamScreen) ──
  const inlineText = contentSource.text as string | undefined;
  const spamBody = typeof inlineText === 'string' ? inlineText.slice(0, 8000) : `${title}\n\n${abstract}`;
  const spam = await runSpamScreen({ title, abstract, body: spamBody }, { modelRouter: ctx.modelRouter });
  if (spam.verdict === 'reject') {
    jres(res, 400, {
      ok: false, error: 'spam_rejected',
      reason: spam.reasons.map((r) => r.code).join(', '),
      core_document_id: null,
      credits_refunded: true, // see contract §7 + w3rr gateway-marker dependency
    });
    return;
  }
  const aspect1ProviderFailure = isAspect1ProviderFailure(spam);

  // ── §6: atomic staged storage ──
  const coreDocId = randomUUID();
  const stagingUuid = randomUUID();
  const stagingDir = join(PORTAL_STORAGE_BASE, '.tmp', stagingUuid);
  const canonicalDir = join(PORTAL_STORAGE_BASE, userId, coreDocId);
  let rawContentPath = '';
  let mainFile = '';

  try {
    await mkdir(stagingDir, { recursive: true });

    if (typeof inlineText === 'string') {
      // Scenario A — inline text
      const ext = contentFormat === 'pdf' ? '.pdf' : contentFormat === 'markdown' ? '.md' : '.tex';
      mainFile = `main${ext}`;
      await writeFile(join(stagingDir, mainFile), inlineText, 'utf-8');
    } else {
      // Scenario B — files already on disk at storage_path; copy into staging.
      // SECURITY: storage_path and main_file are client-supplied. Without an
      // allowlist, cp(storage_path, …) would copy ANY readable directory on
      // the host into the document (arbitrary file disclosure), and a
      // main_file with `..` would escape. Both are constrained below.
      const storagePath = contentSource.storage_path as string | undefined;
      mainFile = (contentSource.main_file as string | undefined) ?? '';
      if (!storagePath || !mainFile) {
        jres(res, 400, { ok: false, error: 'validation_error', message: 'content_source.type=storagebox requires storage_path and main_file' });
        return;
      }
      if (isUnsafeRelPath(mainFile)) {
        jres(res, 400, { ok: false, error: 'invalid_main_file', message: 'main_file must be a relative path with no .. segments' });
        return;
      }
      // Resolve symlinks and require the real path to live inside
      // PORTAL_STORAGE_BASE — the only place legitimate portal content is
      // staged. Blocks anything outside it (system files, server config, etc.).
      const baseReal = await realpath(PORTAL_STORAGE_BASE);
      let storageReal: string;
      try {
        storageReal = await realpath(storagePath);
      } catch {
        jres(res, 400, { ok: false, error: 'invalid_storage_path', message: 'storage_path does not exist' });
        return;
      }
      if (storageReal !== baseReal && !storageReal.startsWith(baseReal + sep)) {
        jres(res, 400, { ok: false, error: 'invalid_storage_path', message: 'storage_path must be inside the portal storage root' });
        return;
      }
      try {
        await access(join(storageReal, mainFile), constants.R_OK);
      } catch {
        jres(res, 400, { ok: false, error: 'file_not_found', message: `Cannot read main_file in storage_path` });
        return;
      }
      await cp(storageReal, stagingDir, { recursive: true });
    }

    // Atomic publish: rename staging → canonical. Same filesystem (both under
    // PORTAL_STORAGE_BASE) so this is a real rename(2), not a cross-fs copy.
    await mkdir(join(PORTAL_STORAGE_BASE, userId), { recursive: true });
    await rename(stagingDir, canonicalDir);
    rawContentPath = join(canonicalDir, mainFile);

    // ── License SPDX normalization (closes jc74) ──
    // Portal docs are ALWAYS full-indexed (openarx-luco product promise;
    // contract §5 amended 2026-06-13, commit 3ecfd20). License is normalized
    // for redistribution / canServeFile correctness but does NOT gate the
    // indexing tier — that only applies to external (arxiv) docs.
    const licenseInfo = normalizeLicense(body.license as string);
    const normalizedLicense = licenseInfo.spdx;
    const tier: 'full' | 'abstract_only' = 'full';

    const authorsRaw = body.authors as Array<Record<string, unknown>>;
    const authors: Author[] = authorsRaw.map((a) => ({
      name: [a.given_name, a.family_name].filter(Boolean).join(' ') || (a.name as string) || 'Unknown',
      givenName: a.given_name as string | undefined,
      familyName: a.family_name as string | undefined,
      orcid: a.orcid as string | undefined,
      email: a.email as string | undefined,
      isCorresponding: a.is_corresponding as boolean | undefined,
    }));

    const codeLinks: CodeLink[] = ((body.code_links as Array<{ url: string }>) ?? []).map((l) => ({ repoUrl: l.url, extractedFrom: 'author' as const }));
    const datasetLinks: DatasetLink[] = ((body.dataset_links as Array<{ name: string; url?: string }>) ?? []).map((l) => ({ name: l.name, url: l.url, extractedFrom: 'author' as const }));
    const benchmarkResults: BenchmarkResult[] = [];

    const portalDocId = (body.portal_document_id as string | undefined) ?? coreDocId;
    const oarxId = computeOarxId('portal', portalDocId);
    const version = (body.version as number | undefined) ?? 1;
    const conceptId = (body.concept_id as string | undefined) ?? coreDocId;

    const attachments = (contentSource.attachments as Array<unknown> | undefined) ?? [];
    const portalMetadata: Record<string, unknown> = {
      content_source: { type: 'storagebox', storage_path: canonicalDir, main_file: mainFile, attachments },
    };
    if (aspect1ProviderFailure) portalMetadata.aspect1_provider_failure = true;

    const sources: Document['sources'] =
      contentFormat === 'pdf' ? { pdf: { path: rawContentPath } }
      : contentFormat === 'markdown' ? { markdown: { path: rawContentPath } }
      : { latex: { path: canonicalDir, rootTex: mainFile } };

    const doc: Document = {
      id: coreDocId,
      version,
      createdAt: new Date(),
      previousVersion: body.previous_version_id as string | undefined,
      conceptId,
      oarxId,
      source: 'portal',
      sourceId: portalDocId,
      sourceUrl: (body.source_url as string | undefined) ?? '',
      title,
      authors,
      abstract,
      categories: (body.categories as string[] | undefined) ?? [],
      publishedAt: new Date(),
      rawContentPath,
      structuredContent: null,
      sources,
      sourceFormat: contentFormat,
      externalIds: { portal: portalDocId, ...(body.doi ? { doi: body.doi as string } : {}), ...(body.arxiv_id ? { arxiv: body.arxiv_id as string } : {}) },
      license: normalizedLicense,
      licenses: licenseInfo.spdx !== 'NOASSERTION' ? { manual: licenseInfo.spdx } : {},
      keywords: (body.keywords as string[] | undefined) ?? undefined,
      language: (body.language as string | undefined) ?? 'en',
      resourceType: (body.resource_type as string | undefined) ?? 'preprint',
      portalMetadata,
      indexingTier: tier,
      codeLinks,
      datasetLinks,
      benchmarkResults,
      status: 'downloaded',
      processingLog: [{ step: 'publish-document', status: 'completed', timestamp: new Date().toISOString() }],
      processingCost: 0,
      provenance: [],
      retryCount: 0,
    };

    await ctx.documentStore.save(doc);

    // Persist publisher + idempotency key. The partial unique index is the
    // real guard: a racing retry that passed the pre-check throws here →
    // caught, cleaned up, returned as 409.
    try {
      await query(
        `UPDATE documents SET publisher_user_id = $1::uuid, idempotency_key = $2 WHERE id = $3::uuid`,
        [userId, idempotencyKey ?? null, coreDocId],
      );
    } catch (err) {
      if (err instanceof Error && /idx_documents_idempotency_key|duplicate key/.test(err.message)) {
        // Lost the race — remove our just-saved row + files, return the winner.
        await query(`DELETE FROM documents WHERE id = $1::uuid`, [coreDocId]).catch(() => {});
        await rm(canonicalDir, { recursive: true, force: true }).catch(() => {});
        const winner = await query<{ id: string; oarx_id: string | null; status: string }>(
          `SELECT id, oarx_id, status FROM documents WHERE publisher_user_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
          [userId, idempotencyKey],
        );
        const w = winner.rows[0];
        jres(res, 409, { ok: true, core_document_id: w?.id ?? null, oarx_id: w?.oarx_id ?? null, status: w?.status ?? 'unknown', idempotent_replay: true });
        return;
      }
      throw err;
    }

    // Initial review row with Aspect 1 result; pipeline fills Aspects 2–4.
    try {
      await createInitialReview({
        documentId: coreDocId,
        triggeredBy: 'auto_on_publish',
        spamVerdict: spam.verdict,
        spamReasons: spam.reasons,
        llmCost: spam.llmCost,
        reportTier: (body.report_tier as 'basic' | 'full') === 'basic' ? 'basic' : 'full',
        status: 'pending',
      });
    } catch (err) {
      console.error('[publish-document] review insert failed (non-fatal):', err instanceof Error ? err.message : err);
    }

    if (ctx.portalDocQueue.isReady) {
      const enqueued = ctx.portalDocQueue.enqueue(doc);
      if (!enqueued) {
        jres(res, 503, { ok: false, error: 'queue_full', core_document_id: coreDocId, message: 'Saved but queue is full; will be processed when capacity frees.' });
        return;
      }
    }

    jres(res, 202, {
      ok: true,
      core_document_id: coreDocId,
      oarx_id: oarxId,
      status: 'downloaded',
      tier,
      storage_path: canonicalDir,
      version,
      concept_id: conceptId,
      review: { aspect1_verdict: spam.verdict, ...(aspect1ProviderFailure ? { aspect1_provider_failure: true } : {}) },
      estimated_processing_seconds: 120,
    });
  } finally {
    // §6: staging dir cleaned on every path. After a successful rename it no
    // longer exists; rm is best-effort for the error/early-return paths.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
