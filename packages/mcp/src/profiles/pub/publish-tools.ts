/**
 * Publisher tools — document submission and management via MCP.
 *
 * These tools proxy to Core's internal API endpoints.
 * Available in /pub/mcp profile (min_token_type: publisher).
 */

import { z } from 'zod';
import { mkdir as fsMkdir, rm as fsRm, readFile as fsReadFile, writeFile as fsWriteFile, copyFile as fsCopyFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { query } from '@openarx/api';
import {
  ARCHIVE_LIMITS,
  ArchiveIntakeError,
  decodeArchive,
  listArchiveEntries,
  resolveMainFile,
  checkFormatMatch,
  buildAttachments,
} from './archive-intake.js';
import { detectKind } from '../../lib/file-magic.js';
import { uploadFilePath } from '../../lib/upload-paths.js';
import { signUpload, UPLOAD_TTL_MS } from '../../lib/upload-signing.js';

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Size ceilings for publish inputs (openarx-contracts-6vz2, security review
 * O-Core-3): unbounded fields let a verified low-tier user push e.g. a 10 MB
 * title straight into PG and the pipeline. Ceilings are arXiv-derived with
 * generous buffers (real titles <250 chars, abstracts ~3K, latex papers
 * 50–500 KB). Shared by BOTH submit_document and create_new_version — the
 * same schema objects are used in both tool shapes, so the limits cannot
 * drift between them.
 */
export const PUBLISH_LIMITS = {
  title: 5_000,
  abstract: 50_000,
  contentText: 2_000_000, // ~2 MB — covers heavy latex with inline figures
  keywordsMax: 50,
  keywordItemMax: 100,
} as const;

export const titleField = z.string().min(1).max(PUBLISH_LIMITS.title);
export const abstractField = z.string().min(1).max(PUBLISH_LIMITS.abstract);
export const keywordsField = z.array(
  z.string().min(1).max(PUBLISH_LIMITS.keywordItemMax),
).max(PUBLISH_LIMITS.keywordsMax).optional();

const LIMITS_NOTE = 'Limits: title ≤5,000 chars; abstract ≤50,000 chars; archive ≤50 MB; keywords ≤50 items × ≤100 chars each.';

const DRY_RUN_NOTE = 'Set dry_run=true to validate without committing: no document is created, nothing is queued, no credits are charged; the response shows what would be saved and the estimated cost.';

export const dryRunField = z.boolean().default(false)
  .describe('Validate only — no document created, no file written, no queue entry, 0 credits. Response: {dry_run:true, validation:"ok", estimated_cost, would_save}.');

/**
 * Published submit cost per content format (openarx-contracts-tof2).
 * Mirrors contracts/economics_config.md (submit_document:latex/markdown=5,
 * submit_document:pdf=10) — used ONLY for the dry-run estimate; real
 * billing happens Portal-side via cost_key lookup.
 */
export function estimatedSubmitCost(format: 'latex' | 'markdown' | 'pdf'): number {
  return format === 'pdf' ? 10 : 5;
}

// ── Archive intake (openarx-contracts-nie7; file-only since w7um §17.2) ──

const ARCHIVE_NOTE = 'Content is file-only: provide a base64-encoded ZIP archive (content_archive_base64) OR a content_ref from an out-of-band upload — exactly one. A ZIP may hold a single PDF, markdown + figures, or multifile LaTeX. Inline text is no longer accepted.';

export const archiveField = z.string()
  .max(ARCHIVE_LIMITS.encodedMax)
  .optional()
  .describe('Base64-encoded ZIP archive (PK\\x03\\x04). Must contain main_file plus any attachments. Mutually exclusive with content_ref. Prefer content_ref (create_upload_url) above ~10 KB.');

export const mainFileField = z.string()
  .min(1).max(255)
  .optional()
  .describe('Filename within the archive to treat as primary content. If exactly one .pdf / .tex / .md file exists at the archive root, auto-inferred when omitted. Otherwise required. For a content_ref ZIP this selects the entry; ignored for a content_ref single file.');

// ── Presigned upload reference (openarx-contracts-xuqi) ─────────────────

const CONTENT_REF_NOTE = 'For content above ~10 KB, prefer create_upload_url → PUT the file to the returned URL → pass the returned file_id as content_ref (avoids base64 token bloat). content_archive_base64 and content_ref are mutually exclusive — provide exactly one.';

export const contentRefField = z.string().uuid().optional()
  .describe('file_id from a successful create_upload_url + PUT upload flow. The uploaded ZIP / PDF / LaTeX / Markdown becomes the document content. Mutually exclusive with content_archive_base64.');

/**
 * Full Portal metadata field set (openarx-contracts-w7um §17.5). All optional,
 * forwarded VERBATIM to /publish-document, which persists each into its column /
 * externalIds / portal_metadata JSONB. Shared by submit_document and
 * create_new_version so the accepted set cannot drift between them.
 */
export const publishMetadataShape = {
  funding: z.array(z.record(z.unknown())).optional()
    .describe('Funding sources, e.g. [{ funder_name, award_number? }].'),
  coi_statement: z.string().optional().describe('Conflict-of-interest statement.'),
  data_availability: z.string().optional().describe('Data-availability statement or status.'),
  data_availability_url: z.string().optional().describe('URL to the dataset / data-availability record.'),
  related_identifiers: z.array(z.record(z.unknown())).optional()
    .describe('Related identifiers, e.g. [{ identifier_type, identifier_value, relation? }].'),
  embargo_until: z.string().optional().describe('ISO-8601 timestamp; the document is embargoed until then.'),
  hubs: z.array(z.string()).optional().describe('Portal hub / topic slugs to associate.'),
  code_links: z.array(z.object({ url: z.string() })).optional().describe('Source-code repositories, e.g. [{ url }].'),
  dataset_links: z.array(z.object({ name: z.string(), url: z.string().optional() })).optional()
    .describe('Datasets, e.g. [{ name, url? }].'),
  benchmark_links: z.array(z.record(z.unknown())).optional().describe('Benchmark-result references.'),
  doi: z.string().optional().describe('DOI of the work.'),
  arxiv_id: z.string().optional().describe('arXiv identifier, if cross-posted.'),
  source_url: z.string().optional().describe('Canonical source URL.'),
  arxiv_categories: z.array(z.string()).optional().describe('arXiv subject categories.'),
} as const;

/** Names of the metadata fields, for picking them out of destructured args. */
const PUBLISH_METADATA_KEYS = Object.keys(publishMetadataShape) as Array<keyof typeof publishMetadataShape>;

/** Pull only the defined metadata fields out of a tool's args bag, for verbatim
 *  forwarding to /publish-document (undefined keys are dropped by JSON). */
function pickPublishMetadata(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLISH_METADATA_KEYS) {
    if (args[k] !== undefined && args[k] !== null) out[k] = args[k];
  }
  return out;
}

interface StagedUpload {
  /** Resolved primary file (rootTex/rootMd, or main.<ext> for a raw single file). */
  mainFile: string;
  attachments: Array<{ filename: string; size: number; type: string }>;
  /** RAW archive file on disk under PORTAL_STORAGE, handed to /publish-document. */
  rawPath: string;
  decodedBytes: number;
  /** true when WE wrote rawPath (base64) and must remove it after the call;
   *  false for a content_ref upload (consumeContentRef owns its lifecycle). */
  ownsRawFile: boolean;
}

/**
 * File-only content-input validation (openarx-contracts-w7um §17.2 — inline
 * content_text dropped). EXACTLY ONE of content_archive_base64 / content_ref.
 * @returns error body for jsonResult, or null when valid.
 */
export function validateContentInputs(
  archiveBase64: string | undefined,
  contentRef: string | undefined,
): { error: string; message: string; path: string[] } | null {
  const provided = [archiveBase64 != null, contentRef != null].filter(Boolean).length;
  if (provided > 1) {
    return { error: 'validation_error', message: 'content_archive_base64 and content_ref are mutually exclusive — provide exactly one', path: ['content_ref'] };
  }
  if (provided === 0) {
    return { error: 'validation_error', message: 'A file upload is required: provide content_archive_base64 (base64 ZIP) or content_ref (from create_upload_url)', path: ['content_ref'] };
  }
  return null; // content_ref is validated against portal_pending_uploads; archive validates during staging
}

/** Structured ArchiveIntakeError → tool error envelope; rethrows the rest. */
function archiveErrorResult(e: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (e instanceof ArchiveIntakeError) {
    return jsonResult({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) });
  }
  throw e;
}

const EXT_BY_FORMAT: Record<'latex' | 'markdown' | 'pdf', string> = {
  latex: '.tex', markdown: '.md', pdf: '.pdf',
};

/**
 * Stage a base64 archive for file-only publishing (openarx-contracts-w7um): the
 * RAW ZIP is written verbatim under PORTAL_STORAGE and handed to
 * /publish-document, which materializes it (transcode → eprint). We only LIST
 * the entries here (no extraction) to resolve/validate main_file + format and
 * build the attachments preview — the endpoint owns the single real extraction.
 */
async function stageArchiveFromBuffer(
  buf: Buffer,
  mainFileArg: string | undefined,
  contentFormat: 'latex' | 'markdown' | 'pdf',
  stagingBase: string,
): Promise<StagedUpload> {
  // decodeArchive already guaranteed ZIP magic + size for the base64 path.
  const files = await listArchiveEntries(buf);
  const mainFile = resolveMainFile(files, mainFileArg);
  checkFormatMatch(mainFile, contentFormat);
  const attachments = buildAttachments(files, mainFile);
  await fsMkdir(stagingBase, { recursive: true });
  const rawPath = pathJoin(stagingBase, `oarx-raw-${crypto.randomUUID()}.zip`);
  await fsWriteFile(rawPath, buf);
  return { mainFile, attachments, rawPath, decodedBytes: buf.length, ownsRawFile: true };
}

/**
 * Stage a content_ref upload for file-only publishing. The uploaded file is
 * already on shared storage under PORTAL_STORAGE, so we pass its path through
 * directly (no copy) and let consumeContentRef remove it after a real publish.
 * A ZIP is validated by listing; a single pdf/tex/md is passed as-is (the
 * endpoint wraps it as a one-file eprint / paper.pdf).
 */
async function stageContentRef(
  uploadPath: string,
  mainFileArg: string | undefined,
  contentFormat: 'latex' | 'markdown' | 'pdf',
): Promise<StagedUpload> {
  const buf = await fsReadFile(uploadPath);
  if (buf.length > ARCHIVE_LIMITS.decodedMax) {
    throw new ArchiveIntakeError('archive_too_large_decoded', `Uploaded file is ${buf.length} bytes; limit is ${ARCHIVE_LIMITS.decodedMax}`, { decoded_bytes: buf.length, limit: ARCHIVE_LIMITS.decodedMax });
  }
  const kind = detectKind(buf.subarray(0, 16));
  if (kind === 'zip') {
    const files = await listArchiveEntries(buf);
    const mainFile = resolveMainFile(files, mainFileArg);
    checkFormatMatch(mainFile, contentFormat);
    return { mainFile, attachments: buildAttachments(files, mainFile), rawPath: uploadPath, decodedBytes: buf.length, ownsRawFile: false };
  }
  // Single non-ZIP file. Sanity-check a declared PDF against its signature; a
  // raw tex/md is wrapped (named main.<ext>) by the endpoint.
  if (contentFormat === 'pdf' && kind !== 'pdf') {
    throw new ArchiveIntakeError('archive_main_file_format_mismatch', 'content_format is pdf but the uploaded file is not a PDF (%PDF- signature)', { expected_format: 'pdf', derived_format: kind });
  }
  return { mainFile: `main${EXT_BY_FORMAT[contentFormat]}`, attachments: [], rawPath: uploadPath, decodedBytes: buf.length, ownsRawFile: false };
}

/** Build the file-only content_source for /publish-document from a staged upload. */
function stagedContentSource(staged: StagedUpload): Record<string, unknown> {
  return { type: 'storagebox', storage_path: staged.rawPath, main_file: staged.mainFile, attachments: staged.attachments };
}

/** Staging root for archive extraction on a REAL submit — must live under
 *  PORTAL_STORAGE_BASE so the /publish-document endpoint's realpath allowlist
 *  accepts the storage_path we hand it (openarx-contracts-w3rr). */
const PORTAL_STORAGE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';
const ARCHIVE_STAGING_BASE = pathJoin(PORTAL_STORAGE, '.mcp-staging');
const PUBLISH_ENDPOINT = `http://127.0.0.1:${process.env.MCP_PORT ?? '3100'}/api/internal/publish-document`;

/** Portal internal API for agent-created drafts (openarx-contracts-amc7;
 *  Portal side delivered by q5ye). create_draft is pure auth + routing — Core
 *  does NO review and NO storage; the draft content passes through verbatim. */
const PORTAL_INTERNAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://localhost:3200';
const PORTAL_PUBLIC_URL = process.env.PORTAL_PUBLIC_URL ?? 'https://portal.openarx.ai';
const DRAFT_ENDPOINT = `${PORTAL_INTERNAL_URL}/api/internal/agent-create-draft`;

/** Marker the gateway honours to skip credit deduction (openarx-contracts-w3rr
 *  Part B). Set on tool results for endpoint responses the user shouldn't pay
 *  for; the gateway reads it and strips it before the SDK serializes. */
export const SKIP_BILLING_MARKER = '__skipBilling';

/**
 * Billing rule (§7): a publish call is chargeable only when the endpoint
 * created a document (202) or recognized an idempotent replay of a real
 * prior submission (409). Every other status is an error envelope the agent
 * can fix and retry — not billed.
 */
export function isChargeablePublishStatus(status: number): boolean {
  return status === 202 || status === 409;
}

/**
 * Call the unified /publish-document endpoint as caller=mcp and translate its
 * response into the MCP tool result (openarx-contracts-w3rr). The endpoint
 * owns consent, SPDX normalization, spam screen, atomic storage, save and
 * enqueue — the tool no longer touches documentStore/queue directly.
 *
 * Billing (§7): only a 202 (created) or 409 (idempotent replay of a real
 * prior submission) is chargeable; every error envelope sets the skip-billing
 * marker so the agent isn't charged for a rejection it can fix and retry.
 */
type PublishToolResult = { content: Array<{ type: 'text'; text: string }>; [SKIP_BILLING_MARKER]?: boolean };

/** POST the payload to /publish-document and return its raw status + body.
 *  Split out from publishViaEndpoint so the content_ref path can inspect the
 *  status (mark the upload consumed only on a real 202). */
async function callPublishEndpoint(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let body: unknown;
  try {
    const resp = await fetch(PUBLISH_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Internal-Secret': process.env.CORE_INTERNAL_SECRET ?? '',
        'X-Caller': 'mcp',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    status = resp.status;
    body = await resp.json();
  } catch (err) {
    body = { ok: false, error: 'publish_unavailable', message: `publish-document call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { status, body };
}

/** Endpoint response → MCP tool result, applying the §7 billing rule: anything
 *  other than 202/409 is a fixable rejection and carries the skip-billing marker. */
function toolResultFromPublish(r: { status: number; body: unknown }): PublishToolResult {
  const result = jsonResult(r.body) as PublishToolResult;
  if (!isChargeablePublishStatus(r.status)) result[SKIP_BILLING_MARKER] = true;
  return result;
}

/** Tag any tool result so the gateway skips credit deduction (a fixable
 *  rejection should never be billed — same rule as the endpoint errors). */
function skipBilling<T extends { content: Array<{ type: 'text'; text: string }> }>(result: T): T & { [SKIP_BILLING_MARKER]?: boolean } {
  (result as Record<string, unknown>)[SKIP_BILLING_MARKER] = true;
  return result;
}

/** A billing-exempt tool error envelope. */
function skipBilledError(error: string, message: string): PublishToolResult {
  return skipBilling(jsonResult({ error, message }));
}

interface PendingUploadRow {
  user_id: string;
  filled_at: Date | null;
  consumed_at: Date | null;
}

/**
 * Validate a content_ref against portal_pending_uploads for this user. On
 * success returns the staged file's absolute path; otherwise a billing-exempt
 * error envelope. Ownership is checked before fill/consume state so one user
 * cannot probe another's upload lifecycle.
 */
async function resolveContentRef(
  contentRef: string,
  userId: string,
): Promise<{ ok: true; uploadPath: string } | { ok: false; result: PublishToolResult }> {
  const { rows } = await query<PendingUploadRow>(
    'SELECT user_id, filled_at, consumed_at FROM portal_pending_uploads WHERE file_id = $1::uuid',
    [contentRef],
  );
  const row = rows[0];
  if (!row) return { ok: false, result: skipBilledError('content_ref_unknown', 'content_ref does not match any upload') };
  if (row.user_id !== userId) return { ok: false, result: skipBilledError('content_ref_not_yours', 'content_ref belongs to a different user') };
  if (row.consumed_at != null) return { ok: false, result: skipBilledError('content_ref_consumed', 'content_ref was already used to publish a document — request a new upload URL') };
  if (row.filled_at == null) return { ok: false, result: skipBilledError('content_ref_not_uploaded', 'no file has been uploaded for this content_ref yet — PUT the file to the upload_url first') };
  return { ok: true, uploadPath: uploadFilePath(userId, contentRef) };
}

/** Mark a consumed upload and remove its now-redundant staged file (the bytes
 *  were copied into the canonical document by /publish-document). Best-effort:
 *  a failure here never fails the publish. */
async function consumeContentRef(contentRef: string, userId: string): Promise<void> {
  await query(
    'UPDATE portal_pending_uploads SET consumed_at = now() WHERE file_id = $1::uuid AND consumed_at IS NULL',
    [contentRef],
  ).catch(() => { /* best effort — publish already succeeded */ });
  await fsRm(uploadFilePath(userId, contentRef), { force: true }).catch(() => { /* best effort */ });
}

/** POST a draft to Portal's agent-create-draft endpoint (openarx-contracts-amc7).
 *  Core forwards content verbatim — no review, no storage. Returns the raw
 *  status + parsed body; status 0 means Portal was unreachable. */
async function callDraftEndpoint(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  try {
    const resp = await fetch(DRAFT_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Internal-Secret': process.env.CORE_INTERNAL_SECRET ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: resp.status, body: await resp.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, body: { error: 'draft_service_unreachable', message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Map MCP author shape → endpoint author shape (given/family names). */
function endpointAuthors(authors: Array<{ given_name: string; family_name: string; orcid?: string }>): Array<Record<string, unknown>> {
  return authors.map((a) => ({ given_name: a.given_name, family_name: a.family_name, orcid: a.orcid }));
}

/**
 * Canonical status glossary for publisher-facing tools
 * (openarx-contracts-4xvb). ONE taxonomy — the real documents.status values,
 * no synthetic mapping. Shared by get_my_documents and get_document_status
 * so the reference cannot drift between the two tools/list descriptions.
 */
export const STATUS_REFERENCE = `Status reference:
  downloaded — accepted, queued for indexing
  parsing — extracting text from latex/markdown/PDF
  translating — auto-translating to English (non-en originals only)
  chunking — splitting content into semantic chunks
  enriching — extracting code/dataset/benchmark links
  embedding — generating vector embeddings (Gemini + SPECTER2)
  ready — fully indexed, searchable
  failed — pipeline error (retryable)
  download_failed — source fetch failed (retryable; rare for Portal submissions)
  duplicate — detected as duplicate of an existing document
  rejected — quality/spam gate rejection (terminal, non-retryable)
  listed — registry-only entry (not user-submitted, only visible to operators)`;

/**
 * categories format guidance (openarx-contracts-9o1k) — doc-only by
 * explicit decision: no regex, no whitelist (Portal is not arXiv-only by
 * contract and arXiv adds subcategories periodically). Shared by both
 * submit_document and create_new_version so the text cannot drift.
 */
export const CATEGORIES_NOTE = `List of subject categories. arXiv format recommended:
\`{domain}.{subcategory}\` where domain is lowercase (with optional hyphens)
and subcategory is two uppercase letters.
Examples: "cs.CL" (Computation and Language), "math.PR" (Probability),
"cond-mat.str-el" (Strongly Correlated Electrons),
"physics.gen-ph" (General Physics).
Other formats accepted but may render inconsistently in search facets.`;

export const STATUS_FILTER_VALUES = [
  'all',
  'downloaded',
  'parsing',
  'translating',
  'chunking',
  'enriching',
  'embedding',
  'ready',
  'failed',
  'download_failed',
  'duplicate',
  'rejected',
  'listed',
] as const;

/**
 * create_new_version metadata inheritance (openarx-contracts-7tyj):
 * categories/keywords/language fall back to the previous version when
 * omitted; an explicitly passed value — including an empty array — wins.
 * Before this, categories were force-inherited, keywords were dropped
 * entirely and language silently reset to 'en' on every revision.
 */
export function resolveVersionMetadata(
  prev: { categories?: string[] | null; keywords?: string[] | null; language?: string | null },
  overrides: { categories?: string[]; keywords?: string[]; language?: string },
): { categories: string[]; keywords: string[]; language: string } {
  return {
    categories: overrides.categories ?? prev.categories ?? [],
    keywords: overrides.keywords ?? prev.keywords ?? [],
    language: overrides.language ?? prev.language ?? 'en',
  };
}


/** Localhost base URL for the internal API (same Express app). Used by
 *  tools that prefer going through the policy-layered endpoint rather
 *  than reaching the DB directly — keeps tier-filter + ownership logic
 *  in one place. */
const INTERNAL_API_BASE = `http://127.0.0.1:${process.env.MCP_PORT ?? '3100'}`;

export function registerPublishTools(server: McpServer, ctx: AppContext): void {

  // ── submit_document ──────────────────────────────────────

  server.tool(
    'submit_document',
    `Submit a document for indexing on OpenArx. Supports LaTeX, Markdown, and PDF formats. Returns a core_document_id for status tracking. ${ARCHIVE_NOTE} ${CONTENT_REF_NOTE} ${LIMITS_NOTE} ${DRY_RUN_NOTE}`,
    {
      title: titleField.describe('Document title'),
      abstract: abstractField.describe('Document abstract'),
      content_format: z.enum(['latex', 'markdown', 'pdf']).describe('Content format'),
      content_archive_base64: archiveField,
      content_ref: contentRefField,
      main_file: mainFileField,
      authors: z.array(z.object({
        given_name: z.string(),
        family_name: z.string(),
        orcid: z.string().optional(),
      })).describe('Author list'),
      license: z.string().default('cc-by-4.0').describe('License (e.g. cc-by-4.0)'),
      language: z.string().default('en').describe('Document language (ISO 639-1)'),
      categories: z.array(z.string()).optional().describe(CATEGORIES_NOTE),
      keywords: keywordsField.describe('Keywords'),
      ...publishMetadataShape,
      dry_run: dryRunField,
    },
    async ({ title, abstract, content_format, content_archive_base64, content_ref, main_file, authors, license, language, categories, keywords, dry_run, ...metadata }, extra) => {
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      // Validation must be IDENTICAL for dry_run and real submits — same
      // schema (SDK level), same refine here; the dry_run branch comes after.
      const inputError = validateContentInputs(content_archive_base64, content_ref);
      if (inputError) return skipBilling(jsonResult(inputError));

      // File-only staging (w7um §17.2): a base64 ZIP is written raw under
      // PORTAL_STORAGE; a content_ref upload is passed through. The endpoint
      // materializes (transcode → eprint) — no pre-extraction here. ownsRawFile
      // staged copies are removed in the finally.
      let staged: StagedUpload | null = null;
      if (content_archive_base64 != null) {
        try {
          staged = await stageArchiveFromBuffer(decodeArchive(content_archive_base64), main_file, content_format, ARCHIVE_STAGING_BASE);
        } catch (e) {
          return skipBilling(archiveErrorResult(e));
        }
      } else if (content_ref != null) {
        if (!portalToken?.userId) return skipBilledError('unauthorized', 'Publisher token required (userId missing)');
        const resolved = await resolveContentRef(content_ref, portalToken.userId);
        if (!resolved.ok) return resolved.result;
        try {
          staged = await stageContentRef(resolved.uploadPath, main_file, content_format);
        } catch (e) {
          return skipBilling(archiveErrorResult(e));
        }
      }
      if (!staged) return skipBilledError('validation_error', 'A file upload is required (content_archive_base64 or content_ref)');

      try {
        if (dry_run) {
          // No ids in would_save: the real save mints fresh UUIDs/oarx ids —
          // returning ones here would mislead the caller.
          return jsonResult({
            dry_run: true,
            validation: 'ok',
            estimated_cost: estimatedSubmitCost(content_format),
            would_save: {
              title,
              abstract,
              content_format,
              content_size_bytes: staged.decodedBytes,
              main_file: staged.mainFile,
              attachments: staged.attachments,
              authors: authors.map((a) => ({
                name: `${a.given_name} ${a.family_name}`,
                givenName: a.given_name,
                familyName: a.family_name,
                orcid: a.orcid,
              })),
              categories: categories ?? [],
              keywords: keywords ?? [],
              language,
              license,
              ...pickPublishMetadata(metadata),
              version: 1,
            },
          });
        }

        // Real submit: forward to the unified /publish-document endpoint
        // (openarx-contracts-w3rr). The endpoint owns consent, SPDX
        // normalization, spam screening, archive materialization, save and
        // enqueue. content_source carries the RAW archive path (w7um §17.1);
        // the full Portal metadata set is forwarded verbatim (§17.5).
        const published = await callPublishEndpoint({
          user_id: portalToken?.userId,
          title,
          abstract,
          authors: endpointAuthors(authors),
          content_format,
          content_source: stagedContentSource(staged),
          license,
          categories,
          keywords,
          language,
          ...pickPublishMetadata(metadata),
          idempotency_key: crypto.randomUUID(),
        });
        // Burn the upload only after the doc was really created (202).
        if (content_ref != null && published.status === 202 && portalToken?.userId) {
          await consumeContentRef(content_ref, portalToken.userId);
        }
        return toolResultFromPublish(published);
      } finally {
        // Remove the raw archive we staged for a base64 submit (the endpoint
        // already materialized it). A content_ref upload is left for
        // consumeContentRef / the cleanup job.
        if (staged.ownsRawFile) await fsRm(staged.rawPath, { force: true }).catch(() => { /* best effort */ });
      }
    },
  );

  // ── get_my_documents ─────────────────────────────────────

  server.tool(
    'get_my_documents',
    `List documents you have submitted through OpenArx Portal.\n\n${STATUS_REFERENCE}`,
    {
      limit: z.number().int().min(1).max(50).default(20).describe('Max results'),
      status: z.enum(STATUS_FILTER_VALUES).default('all').describe('Filter by status; see Status reference in tool description'),
    },
    async ({ limit, status }) => {
      // NOTE: not yet user-scoped — lists all source='portal' documents
      // (per-user filtering via the auth context is a separate concern).
      const useStatusFilter = status !== 'all';
      const result = await query<{ id: string; oarx_id: string; title: string; status: string; created_at: Date; chunks_count: string }>(
        `SELECT d.id, d.oarx_id, d.title, d.status, d.created_at,
                (SELECT count(*)::text FROM chunks WHERE document_id = d.id) as chunks_count
         FROM documents d
         WHERE d.source = 'portal' ${useStatusFilter ? 'AND d.status = $2' : ''}
         ORDER BY d.created_at DESC LIMIT $1`,
        useStatusFilter ? [limit, status] : [limit],
      );

      return jsonResult({
        documents: result.rows.map((r) => ({
          id: r.id,
          oarx_id: r.oarx_id,
          title: r.title,
          status: r.status,
          created_at: r.created_at.toISOString(),
          chunks_count: parseInt(r.chunks_count, 10),
        })),
        total: result.rows.length,
      });
    },
  );

  // ── get_document_status ──────────────────────────────────

  server.tool(
    'get_document_status',
    `Check the processing status of a submitted document.\n\n${STATUS_REFERENCE}`,
    {
      document_id: z.string().describe('Core document ID (UUID)'),
    },
    async ({ document_id }) => {
      const doc = await ctx.documentStore.getById(document_id);
      if (!doc) return jsonResult({ error: 'not_found', message: 'Document not found' });

      const { rows } = await ctx.pool.query<{ count: string }>(
        'SELECT count(*)::text as count FROM chunks WHERE document_id = $1',
        [document_id],
      );

      return jsonResult({
        id: doc.id,
        oarx_id: (doc as unknown as Record<string, unknown>).oarxId ?? null,
        title: doc.title,
        status: doc.status,
        chunks_count: parseInt(rows[0]?.count ?? '0', 10),
        queue_position: ctx.portalDocQueue.queuePosition(document_id),
      });
    },
  );

  // ── create_new_version ───────────────────────────────────

  server.tool(
    'create_new_version',
    `Submit a new version of an existing document. The previous version's chunks will be marked as not-latest. Omit \`categories\`, \`keywords\`, or \`language\` to inherit each independently from the previous version; pass a value to override. ${ARCHIVE_NOTE} ${CONTENT_REF_NOTE} ${LIMITS_NOTE} ${DRY_RUN_NOTE}`,
    {
      previous_document_id: z.string().describe('Core document ID of the previous version'),
      title: titleField.describe('Updated title'),
      abstract: abstractField.describe('Updated abstract'),
      content_format: z.enum(['latex', 'markdown', 'pdf']).describe('Content format'),
      authors: z.array(z.object({
        given_name: z.string(),
        family_name: z.string(),
        orcid: z.string().optional(),
      })).describe('Author list'),
      license: z.string().default('cc-by-4.0').describe('License'),
      categories: z.array(z.string()).optional()
        .describe(`Override. Omit to inherit from previous version. ${CATEGORIES_NOTE}`),
      keywords: keywordsField
        .describe('Override. Omit to inherit from previous version.'),
      language: z.string().optional()
        .describe('Override (ISO 639-1). Omit to inherit from previous version.'),
      content_archive_base64: archiveField,
      content_ref: contentRefField,
      main_file: mainFileField,
      ...publishMetadataShape,
      dry_run: dryRunField,
    },
    async ({ previous_document_id, title, abstract, content_format, content_archive_base64, content_ref, main_file, authors, license, categories, keywords, language, dry_run, ...metadata }, extra) => {
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      // Validation must be IDENTICAL for dry_run and real submits — same
      // schema (SDK level), same refine here; the dry_run branch comes after
      // prev-doc resolution so would_save reflects real inheritance.
      const inputError = validateContentInputs(content_archive_base64, content_ref);
      if (inputError) return skipBilling(jsonResult(inputError));

      const prevDoc = await ctx.documentStore.getById(previous_document_id);
      if (!prevDoc) return jsonResult({ error: 'not_found', message: 'Previous document not found' });

      const conceptId = (prevDoc as unknown as Record<string, unknown>).conceptId as string ?? prevDoc.id;
      const newVersion = prevDoc.version + 1;
      // Inheritance is resolved HERE (needs prevDoc); the generic endpoint
      // does not inherit, so we pass the already-resolved values down.
      const inherited = resolveVersionMetadata(prevDoc, { categories, keywords, language });

      let staged: StagedUpload | null = null;
      if (content_archive_base64 != null) {
        try {
          staged = await stageArchiveFromBuffer(decodeArchive(content_archive_base64), main_file, content_format, ARCHIVE_STAGING_BASE);
        } catch (e) {
          return skipBilling(archiveErrorResult(e));
        }
      } else if (content_ref != null) {
        if (!portalToken?.userId) return skipBilledError('unauthorized', 'Publisher token required (userId missing)');
        const resolved = await resolveContentRef(content_ref, portalToken.userId);
        if (!resolved.ok) return resolved.result;
        try {
          staged = await stageContentRef(resolved.uploadPath, main_file, content_format);
        } catch (e) {
          return skipBilling(archiveErrorResult(e));
        }
      }
      if (!staged) return skipBilledError('validation_error', 'A file upload is required (content_archive_base64 or content_ref)');

      try {
      if (dry_run) {
        return jsonResult({
          dry_run: true,
          validation: 'ok',
          estimated_cost: estimatedSubmitCost(content_format),
          would_save: {
            title,
            abstract,
            content_format,
            content_size_bytes: staged.decodedBytes,
            main_file: staged.mainFile,
            attachments: staged.attachments,
            authors: authors.map((a) => ({
              name: `${a.given_name} ${a.family_name}`,
              givenName: a.given_name,
              familyName: a.family_name,
              orcid: a.orcid,
            })),
            categories: inherited.categories,
            keywords: inherited.keywords,
            language: inherited.language,
            license,
            ...pickPublishMetadata(metadata),
            version: newVersion,
          },
        });
      }

      // Real submit: forward to /publish-document with the resolved
      // inheritance + version lineage (openarx-contracts-w3rr) and the file-only
      // content_source (w7um §17.1) + verbatim metadata (§17.5).
      const published = await callPublishEndpoint({
        user_id: portalToken?.userId,
        title,
        abstract,
        authors: endpointAuthors(authors),
        content_format,
        content_source: stagedContentSource(staged),
        license,
        categories: inherited.categories,
        keywords: inherited.keywords,
        language: inherited.language,
        ...pickPublishMetadata(metadata),
        previous_version_id: previous_document_id,
        concept_id: conceptId,
        version: newVersion,
        idempotency_key: crypto.randomUUID(),
      });
      // Burn the upload only after the new version was really created (202).
      if (content_ref != null && published.status === 202 && portalToken?.userId) {
        await consumeContentRef(content_ref, portalToken.userId);
      }
      return toolResultFromPublish(published);
      } finally {
        if (staged.ownsRawFile) await fsRm(staged.rawPath, { force: true }).catch(() => { /* best effort */ });
      }
    },
  );

  // ── get_my_document_review ───────────────────────────────
  // Publisher reads their own content-review report. Zero credits —
  // reading own review is free per contract §5.5. Tier filtering and
  // ownership check happen in the internal endpoint (C4); this tool
  // just forwards the caller's user_id from the OAuth token.

  server.tool(
    'get_my_document_review',
    'Read the content-review report for one of your own documents. Returns spam verdict, novelty, grounding, similar documents. Basic-tier documents return a condensed summary; upgrade to full for detailed aspects.',
    {
      documentId: z.string().uuid().describe('Core document UUID (same id returned by submit_document.core_document_id)'),
    },
    async ({ documentId }, extra) => {
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      const userId = portalToken?.userId;
      if (!userId) {
        return jsonResult({ error: 'unauthorized', message: 'Publisher token required (userId missing)' });
      }
      const internalSecret = process.env.CORE_INTERNAL_SECRET;
      if (!internalSecret) {
        return jsonResult({ error: 'server_error', message: 'CORE_INTERNAL_SECRET not configured' });
      }
      const url = `${INTERNAL_API_BASE}/api/internal/content-review/${encodeURIComponent(documentId)}?user_id=${encodeURIComponent(userId)}`;
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: { 'X-Internal-Secret': internalSecret },
        });
        const body = await resp.json().catch(() => ({}));
        if (resp.status === 403) return jsonResult({ error: 'forbidden', message: 'not_owner' });
        if (resp.status === 404) return jsonResult({ error: 'not_found', message: 'Review not found for this document' });
        if (!resp.ok) return jsonResult({ error: 'server_error', message: `internal_${resp.status}`, details: body });
        return jsonResult(body);
      } catch (err) {
        return jsonResult({
          error: 'server_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── create_upload_url (openarx-contracts-xuqi) ───────────
  // Mint a short-lived presigned PUT URL so an agent can upload large content
  // out-of-band instead of base64-inlining it (token-rendering cost + escape
  // fragility make inline hostile above ~10 KB). Free: the billable event is
  // the subsequent submit_document / create_new_version with content_ref.

  server.tool(
    'create_upload_url',
    'Request a short-lived presigned PUT URL for uploading publishing content. Use when content exceeds practical inline-parameter limits (~10 KB). After uploading the file to the returned URL with an HTTP PUT, pass the file_id as content_ref to submit_document or create_new_version. The URL expires in 10 minutes and accepts a single file up to 50 MB.',
    {
      expected_size_bytes: z.number().int().min(1).max(50_000_000).optional()
        .describe('Hint for the upload size (≤50 MB is enforced on upload regardless).'),
      expected_content_type: z.enum(['application/zip', 'application/pdf', 'text/x-tex', 'text/markdown']).optional()
        .describe('Optional hint for what you intend to upload. A magic-byte check runs on PUT; if set to application/zip or application/pdf the bytes must match that signature.'),
    },
    async ({ expected_size_bytes, expected_content_type }, extra) => {
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      const userId = portalToken?.userId;
      if (!userId) return skipBilledError('unauthorized', 'Publisher token required (userId missing)');

      const fileId = crypto.randomUUID();
      const expiresUnix = Math.floor((Date.now() + UPLOAD_TTL_MS) / 1000);
      const signature = signUpload(fileId, expiresUnix);
      const base = process.env.MCP_PUBLIC_URL ?? 'https://mcp.openarx.ai';
      const uploadUrl = `${base}/api/upload/${fileId}?expires=${expiresUnix}&signature=${signature}`;

      await query(
        `INSERT INTO portal_pending_uploads
           (file_id, user_id, expires_at, expected_content_type, expected_size_bytes)
         VALUES ($1::uuid, $2::uuid, to_timestamp($3), $4, $5)`,
        [fileId, userId, expiresUnix, expected_content_type ?? null, expected_size_bytes ?? null],
      );

      // Requesting a URL is free; mark skip-billing so it never deducts credits
      // regardless of Portal cost config (the publish call is the billed event).
      return skipBilling(jsonResult({
        file_id: fileId,
        upload_url: uploadUrl,
        expires_at: new Date(expiresUnix * 1000).toISOString(),
        max_bytes: 50_000_000,
        method: 'PUT',
      }));
    },
  );

  // ── create_draft (openarx-contracts-amc7; file-only since w7um §17) ──────
  // Hand a draft to Portal's editor instead of publishing. Core does ONLY auth
  // + routing + binary-safe staging: it MOVES the uploaded bytes verbatim onto
  // shared storage and tells Portal where they live — no content review, no
  // parsing, no transcode. Free (0 credits). The content_ref upload is consumed
  // on success (an upload flows into a draft OR a submit, never both).

  server.tool(
    'create_draft',
    'Create an editable draft in the OpenArx Portal instead of publishing immediately. Returns a draft_id and an edit_url the user can open to review/edit before publishing. Drafts are file-only: first call create_upload_url, PUT your ZIP/PDF, then pass the returned file_id as content_ref. No content review runs and nothing is indexed — this is Portal workflow state, not corpus knowledge (drafts do not appear in get_my_documents).',
    {
      title: titleField.describe('Draft title'),
      format: z.enum(['latex', 'markdown', 'pdf']).describe('Content format'),
      content_ref: contentRefField.describe('file_id from create_upload_url + PUT. The uploaded ZIP/PDF becomes the draft content (required — drafts are file-only).'),
      metadata: z.record(z.unknown()).optional()
        .describe('Optional metadata block — same field set as submit_document (authors, abstract, license, funding, coi_statement, data_availability, related_identifiers, embargo_until, hubs, code_links, dataset_links, benchmark_links, doi, arxiv_id, source_url, arxiv_categories, …). Forwarded to the draft verbatim.'),
    },
    async ({ title, format, content_ref, metadata }, extra) => {
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      const userId = portalToken?.userId;
      if (!userId) return skipBilledError('user_required', 'Publisher token required (userId missing)');

      if (!content_ref) {
        return skipBilledError('validation_error', 'content_ref is required — drafts are file-only (create_upload_url → PUT → pass the file_id)');
      }
      const resolved = await resolveContentRef(content_ref, userId);
      if (!resolved.ok) return resolved.result;

      // Stage the uploaded bytes VERBATIM (binary-safe copy — never a UTF-8 read,
      // which corrupted ZIP/PDF uploads before w7um D5) into a deterministic
      // draft dir on shared storage. draft_id is minted Core-side so the target
      // path is known before Portal responds; Portal reads from storage_path.
      const draftId = crypto.randomUUID();
      const originalFilename = format === 'pdf' ? 'upload.pdf' : 'upload.zip';
      const draftDir = pathJoin(PORTAL_STORAGE, 'drafts', userId, draftId);
      const storagePath = pathJoin(draftDir, originalFilename);
      try {
        await fsMkdir(draftDir, { recursive: true });
        await fsCopyFile(resolved.uploadPath, storagePath);
      } catch {
        await fsRm(draftDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
        return skipBilledError('draft_service_unavailable', 'uploaded content could not be staged for the draft');
      }

      const { status, body } = await callDraftEndpoint({
        user_id: userId,
        draft_id: draftId,
        title,
        format,
        storage_path: storagePath,
        original_filename: originalFilename,
        metadata: metadata ?? {},
      });
      if (status < 200 || status >= 300) {
        // Portal rejected — drop the staged copy so the content_ref stays
        // reusable (the upload is NOT consumed below).
        await fsRm(draftDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
        return skipBilledError('draft_service_unavailable', `draft service returned ${status || 'no response'}`);
      }
      const b = (body ?? {}) as Record<string, unknown>;
      // Portal echoes our draft_id (or mints its own); prefer its response.
      const returnedDraftId = (b.draft_id as string | undefined) ?? (b.id as string | undefined) ?? draftId;

      // Draft created → burn the upload so it can't also be submitted (xuqi
      // lifecycle). The bytes already live in the draft dir; this removes the
      // now-redundant .uploads copy and marks the content_ref consumed.
      await consumeContentRef(content_ref, userId);

      const editUrl = (b.edit_url as string | undefined) ?? `${PORTAL_PUBLIC_URL}/portal/drafts/${returnedDraftId}`;
      // Free tool — never deduct credits (the billable event is publishing, not drafting).
      return skipBilling(jsonResult({ draft_id: returnedDraftId, edit_url: editUrl }));
    },
  );
}
