/**
 * Internal API routes — REST endpoints for Portal (no MCP overhead).
 *
 * Auth: X-Internal-Secret header (shared secret between Core ↔ Portal).
 * Billing: Portal handles credit deduction before calling these endpoints.
 *
 * POST /api/internal/search              — hybrid search with document metadata
 * POST /api/internal/ingest-document     — queue Portal document for pipeline processing
 * GET  /api/internal/documents/:id       — document details
 * GET  /api/internal/documents/:id/pdf   — stream PDF file
 */

import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { access, constants, mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import archiver from 'archiver';
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import type { AppContext } from './context.js';
import type { SearchResult, Document, Author, CodeLink, DatasetLink, BenchmarkResult } from '@openarx/types';
import type { BM25Result, ReportTier } from '@openarx/api';
import {
  createInitialReview,
  triggerReview,
  getLatestReview,
  getReviewByVersion,
  getAllReviewVersions,
  patchLatestReviewTier,
  query,
} from '@openarx/api';
import { isOpenLicense, runSpamScreen, type SpamScreenResult } from '@openarx/ingest';
import type { SpdxLicense } from '@openarx/ingest';

const INTERNAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';

function canServeFile(doc: Document): boolean {
  if (!doc.license || doc.license === 'NOASSERTION') return true;
  return isOpenLicense(doc.license as SpdxLicense);
}

// ── Helpers ─────────────────────────────────────────────────

/** Determine which download formats are available for a document. */
function getAvailableFormats(doc: Document): string[] {
  const formats: string[] = [];
  const sources = (doc as unknown as Record<string, unknown>).sources as
    Record<string, { path?: string }> | undefined;

  if (sources?.pdf?.path) formats.push('pdf');
  if (sources?.latex?.path) formats.push('latex');
  if (sources?.markdown?.path) formats.push('markdown');

  // Fallback: sourceFormat indicates format even if sources key is missing
  if (doc.sourceFormat === 'latex' && !formats.includes('latex') && doc.rawContentPath) {
    formats.push('latex');
  }
  if (doc.sourceFormat === 'markdown' && !formats.includes('markdown') && doc.rawContentPath) {
    formats.push('markdown');
  }

  return formats;
}

// ── Auth middleware ──────────────────────────────────────────

function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  if (!INTERNAL_SECRET) {
    res.status(500).json({ error: 'CORE_INTERNAL_SECRET not configured' });
    return;
  }
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== INTERNAL_SECRET) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid internal secret' });
    return;
  }
  next();
}

// ── Search helpers (reused from profiles/shared) ────────────

const VECTOR_WEIGHT = Number(process.env.VECTOR_WEIGHT ?? 0.6);
const BM25_WEIGHT = Number(process.env.BM25_WEIGHT ?? 0.4);
const MAX_CHUNK_DISPLAY = 800;

interface HybridResult {
  chunkId: string;
  documentId: string;
  content: string;
  context: Record<string, unknown>;
  vectorScore: number;
  bm25Score: number;
  finalScore: number;
}

function mergeHybrid(vectorResults: SearchResult[], bm25Results: BM25Result[]): HybridResult[] {
  const merged = new Map<string, HybridResult>();

  for (const r of vectorResults) {
    merged.set(r.chunkId, {
      chunkId: r.chunkId, documentId: r.documentId, content: r.content,
      context: r.context as unknown as Record<string, unknown>,
      vectorScore: r.score, bm25Score: 0, finalScore: 0,
    });
  }
  for (const r of bm25Results) {
    const existing = merged.get(r.chunkId);
    if (existing) { existing.bm25Score = r.bm25Score; }
    else {
      merged.set(r.chunkId, {
        chunkId: r.chunkId, documentId: r.documentId, content: r.content,
        context: r.context as unknown as Record<string, unknown>,
        vectorScore: 0, bm25Score: r.bm25Score, finalScore: 0,
      });
    }
  }
  for (const r of merged.values()) {
    r.finalScore = VECTOR_WEIGHT * r.vectorScore + BM25_WEIGHT * r.bm25Score;
  }
  return [...merged.values()].sort((a, b) => b.finalScore - a.finalScore);
}

function diversify(results: HybridResult[], maxPerDoc: number): HybridResult[] {
  const counts = new Map<string, number>();
  return results.filter((r) => {
    const c = counts.get(r.documentId) ?? 0;
    if (c >= maxPerDoc) return false;
    counts.set(r.documentId, c + 1);
    return true;
  });
}

function truncate(text: string): string {
  return text.length <= MAX_CHUNK_DISPLAY ? text : text.slice(0, MAX_CHUNK_DISPLAY) + '...';
}

// ── Route registration ──────────────────────────────────────

export function registerInternalRoutes(app: Express, ctx: AppContext): void {
  const router = express.Router();
  router.use(express.json());
  router.use(requireInternalSecret);

  // ── POST /search ────────────────────────────────────────

  router.post('/search', async (req: Request, res: Response) => {
    const start = Date.now();
    try {
      const { query, strategy, categories, date_from, date_to, limit } = req.body as {
        query?: string; strategy?: string; categories?: string[];
        date_from?: string; date_to?: string; limit?: number;
      };

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        res.status(400).json({ error: 'query is required' });
        return;
      }

      const effectiveLimit = Math.max(1, Math.min(50, limit ?? 10));
      const useRerank = strategy === 'rerank';

      // Stage 1: embed query
      const resp = await ctx.geminiEmbedder.embed([query]);
      const vector = resp.vectors[0];

      // Stage 2: hybrid retrieval
      const candidateCount = useRerank ? Math.max(15, effectiveLimit * 3)
        : (categories || date_from || date_to ? effectiveLimit * 3 : effectiveLimit * 2);

      const [vectorRaw, bm25Raw] = await Promise.all([
        ctx.vectorStore.search(vector, 'gemini', candidateCount, undefined, 2),
        ctx.searchStore.searchBM25(query, candidateCount),
      ]);

      let hybrid = mergeHybrid(vectorRaw, bm25Raw);

      // Stage 3: optional rerank
      if (useRerank) {
        const candidates = hybrid.slice(0, 15);
        try {
          const passages = candidates.map((c) => c.content);
          const rerankResult = await ctx.rerankerClient.rerank(query, passages);
          hybrid = rerankResult.scores.map((s) => ({
            ...candidates[s.index],
            finalScore: s.score,
          }));
        } catch {
          // fallback to linear fusion
        }
      }

      const deduped = diversify(hybrid, 2);

      // Stage 4: enrich from PostgreSQL (categories, published_at).
      // Defence-in-depth: also drop tombstoned docs here, even though
      // mergeLatestGuard is supposed to filter them at the Qdrant layer
      // and BM25 path mirrors deleted_at IS NULL — keeps the invariant
      // even if either of those guards regresses.
      const docIds = [...new Set(deduped.map((r) => r.documentId))];
      const docs = new Map<string, Document>();
      const docResults = await Promise.all(docIds.map((id) => ctx.documentStore.getById(id)));
      for (const doc of docResults) {
        if (doc && !doc.deletedAt) docs.set(doc.id, doc);
      }

      // Stage 5: post-filter and format
      const dateFromMs = date_from ? new Date(date_from).getTime() : undefined;
      const dateToMs = date_to ? new Date(date_to).getTime() : undefined;
      const categorySet = categories ? new Set(categories) : undefined;

      const results = deduped
        .map((r) => {
          const doc = docs.get(r.documentId);
          if (!doc) return null;
          if (categorySet && !doc.categories.some((c) => categorySet.has(c))) return null;
          const pubMs = doc.publishedAt.getTime();
          if (dateFromMs && pubMs < dateFromMs) return null;
          if (dateToMs && pubMs > dateToMs) return null;

          return {
            document_id: r.documentId,
            document_title: doc.title,
            original_title: doc.originalTitle ?? null,
            original_language: doc.language && doc.language !== 'en' ? doc.language : null,
            license: doc.license ?? null,
            licenses: doc.licenses ?? {},
            indexing_tier: doc.indexingTier ?? 'full',
            can_serve_file: canServeFile(doc),
            available_formats: getAvailableFormats(doc),
            authors: doc.authors,
            source_url: doc.sourceUrl,
            arxiv_categories: doc.categories,
            published_at: doc.publishedAt.toISOString(),
            version: doc.version,
            concept_id: doc.conceptId ?? doc.id,
            chunk_content: truncate(r.content),
            chunk_context: {
              section_name: r.context.sectionName ?? null,
              section_path: r.context.sectionPath ?? null,
              position_in_document: r.context.positionInDocument ?? 0,
              total_chunks: r.context.totalChunks ?? 0,
              summary: r.context.summary ?? null,
              key_concept: r.context.keyConcept ?? null,
              content_type: r.context.contentType ?? null,
              // Search v2 (openarx-g8af): exposed for entity-driven filters
              // and citation safety. Backfilled via scripts/backfill-qdrant-payload.mjs.
              entities: Array.isArray(r.context.entities) ? r.context.entities : null,
              self_contained: typeof r.context.selfContained === 'boolean'
                ? r.context.selfContained
                : null,
            },
            score: r.finalScore,
            vector_score: r.vectorScore,
            bm25_score: r.bm25Score,
          };
        })
        .filter(Boolean)
        .slice(0, effectiveLimit);

      res.json({
        results,
        total: results.length,
        strategy_used: useRerank ? 'rerank' : 'fast',
        latency_ms: Date.now() - start,
      });
    } catch (err) {
      console.error('[internal/search] Error:', err instanceof Error ? err.message : err);
      console.error('[internal/search] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'search_error' });
    }
  });

  // ── GET /documents/:id ──────────────────────────────────

  router.get('/documents/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const doc = await ctx.documentStore.getById(id);
      // Soft-delete §3.1 invariant: deleted doc returns identical-shape
      // 404 to never-existed ID — Portal must not leak tombstoned metadata.
      if (!doc || doc.deletedAt) {
        res.status(404).json({ error: 'not_found', message: 'Document not found' });
        return;
      }

      const conceptId = doc.conceptId ?? doc.id;

      // Parallel: chunk count + all versions of same concept
      const [chunkCountResult, allVersionsResult] = await Promise.all([
        ctx.pool.query<{ count: string }>(
          'SELECT count(*)::text as count FROM chunks WHERE document_id = $1',
          [id],
        ),
        ctx.pool.query<{ id: string; version: number; status: string; created_at: Date }>(
          'SELECT id, version, status, created_at FROM documents WHERE concept_id = $1 ORDER BY version ASC',
          [conceptId],
        ),
      ]);

      const allVersions = allVersionsResult.rows.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        created_at: v.created_at.toISOString(),
      }));

      res.json({
        document: {
          id: doc.id,
          title: doc.title,
          abstract: doc.abstract,
          original_title: doc.originalTitle ?? null,
          original_abstract: doc.originalAbstract ?? null,
          original_language: doc.language && doc.language !== 'en' ? doc.language : null,
          license: doc.license ?? null,
          licenses: doc.licenses ?? {},
          indexing_tier: doc.indexingTier ?? 'full',
          can_serve_file: canServeFile(doc),
          available_formats: getAvailableFormats(doc),
          authors: doc.authors,
          source_url: doc.sourceUrl,
          arxiv_categories: doc.categories,
          published_at: doc.publishedAt.toISOString(),
          version: doc.version,
          concept_id: conceptId,
          previous_version_id: doc.previousVersion ?? null,
          all_versions: allVersions,
          external_ids: doc.externalIds ?? {},
          code_links: doc.codeLinks ?? [],
          dataset_links: doc.datasetLinks ?? [],
          benchmark_results: doc.benchmarkResults ?? [],
          chunks_count: parseInt(chunkCountResult.rows[0]?.count ?? '0', 10),
          status: doc.status,
        },
      });
    } catch (err) {
      console.error('[internal/documents] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── GET /documents/:id/pdf ──────────────────────────────

  router.get('/documents/:id/pdf', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const doc = await ctx.documentStore.getById(id);
      // Tombstoned docs must not leak files (spec §3.1).
      if (!doc || doc.deletedAt) {
        res.status(404).json({ error: 'not_found', message: 'Document not found' });
        return;
      }

      // Only serve actual PDF files — not LaTeX/Markdown via rawContentPath fallback
      const sources = (doc as unknown as Record<string, unknown>).sources as
        Record<string, { path?: string }> | undefined;
      const pdfPath = sources?.pdf?.path;

      if (!pdfPath) {
        res.status(404).json({ error: 'not_found', message: 'PDF not available for this document' });
        return;
      }

      try {
        await access(pdfPath, constants.R_OK);
      } catch {
        res.status(404).json({ error: 'not_found', message: 'PDF file not found on disk' });
        return;
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.sourceId}.pdf"`);
      createReadStream(pdfPath).pipe(res);
    } catch (err) {
      console.error('[internal/pdf] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── GET /documents/:id/download ─────────────────────────

  router.get('/documents/:id/download', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const format = req.query.format as string | undefined;

      if (!format || !['pdf', 'latex', 'markdown'].includes(format)) {
        res.status(400).json({ error: 'invalid_format', message: 'format query param required: pdf, latex, or markdown' });
        return;
      }

      const doc = await ctx.documentStore.getById(id);
      // Tombstoned docs must not leak files (spec §3.1).
      if (!doc || doc.deletedAt) {
        res.status(404).json({ error: 'not_found', message: 'Document not found' });
        return;
      }

      const formats = getAvailableFormats(doc);
      if (!formats.includes(format)) {
        res.status(404).json({ error: 'format_unavailable', message: `Format "${format}" not available. Available: ${formats.join(', ') || 'none'}` });
        return;
      }

      const sources = (doc as unknown as Record<string, unknown>).sources as
        Record<string, { path?: string; rootTex?: string; manifest?: boolean; texFiles?: number }> | undefined;
      const oarxId = doc.oarxId ?? doc.sourceId;

      if (format === 'pdf') {
        const pdfPath = sources?.pdf?.path;
        if (!pdfPath) { res.status(404).json({ error: 'not_found' }); return; }
        try { await access(pdfPath, constants.R_OK); } catch { res.status(404).json({ error: 'file_not_found' }); return; }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${oarxId}.pdf"`);
        createReadStream(pdfPath).pipe(res);
        return;
      }

      if (format === 'markdown') {
        const mdPath = sources?.markdown?.path;
        if (!mdPath) { res.status(404).json({ error: 'not_found' }); return; }
        try { await access(mdPath, constants.R_OK); } catch { res.status(404).json({ error: 'file_not_found' }); return; }
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${oarxId}.md"`);
        createReadStream(mdPath).pipe(res);
        return;
      }

      if (format === 'latex') {
        const latexInfo = sources?.latex;
        if (!latexInfo?.path) { res.status(404).json({ error: 'not_found' }); return; }
        const latexPath = latexInfo.path;
        try { await access(latexPath, constants.R_OK); } catch { res.status(404).json({ error: 'file_not_found' }); return; }

        // Check if directory (arXiv source archive) or single file (portal inline)
        const fileStat = await stat(latexPath);
        if (fileStat.isDirectory()) {
          // Zip the directory
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${oarxId}-source.zip"`);
          const archive = archiver('zip', { zlib: { level: 6 } });
          archive.on('error', (err) => { console.error('[internal/download] Zip error:', err.message); res.status(500).json({ error: 'zip_error' }); });
          archive.pipe(res);
          archive.directory(latexPath, false);
          await archive.finalize();
        } else {
          // Single .tex file
          res.setHeader('Content-Type', 'application/x-tex; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${oarxId}.tex"`);
          createReadStream(latexPath).pipe(res);
        }
        return;
      }
    } catch (err) {
      console.error('[internal/download] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── POST /ingest-document ──────────────────────────────

  const PORTAL_STORAGE_BASE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';

  router.post('/ingest-document', async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;

      // ── Validate required fields ──
      const portalDocId = body.portal_document_id as string | undefined;
      const title = body.title as string | undefined;
      const abstract = body.abstract as string | undefined;
      const contentFormat = body.content_format as string | undefined;
      const contentSource = body.content_source as Record<string, unknown> | undefined;
      const license = body.license as string | undefined;
      const authorsRaw = body.authors as Array<Record<string, unknown>> | undefined;

      if (!portalDocId || !title || !abstract || !contentFormat || !contentSource || !license || !authorsRaw?.length) {
        res.status(400).json({
          error: 'validation_error',
          message: 'Required fields: portal_document_id, title, authors, abstract, content_format, content_source, license',
        });
        return;
      }

      if (!['latex', 'markdown', 'pdf'].includes(contentFormat)) {
        res.status(400).json({ error: 'validation_error', message: 'content_format must be latex, markdown, or pdf' });
        return;
      }

      // ── Check idempotency — if already exists, return existing ID ──
      const existing = await ctx.documentStore.getBySourceId('portal', portalDocId);
      if (existing) {
        if (['parsing', 'chunking', 'enriching', 'embedding'].includes(existing.status)) {
          res.status(409).json({
            error: 'already_processing',
            core_document_id: existing.id,
            status: existing.status,
            message: 'Document is currently being processed',
          });
          return;
        }
        // If document is in downloaded/failed — re-enqueue for processing
        if ((existing.status === 'downloaded' || existing.status === 'failed') && ctx.portalDocQueue.isReady) {
          ctx.portalDocQueue.enqueue(existing);
          res.status(202).json({
            ok: true,
            core_document_id: existing.id,
            status: 'queued',
            message: 'Document re-queued for processing',
          });
          return;
        }
        // Already done — return existing
        res.status(200).json({
          ok: true,
          core_document_id: existing.id,
          status: existing.status,
          message: existing.status === 'ready' ? 'Document already indexed' : 'Document exists',
        });
        return;
      }

      // ── Validate previous_version_id if provided ──
      const previousVersionId = body.previous_version_id as string | undefined;
      if (previousVersionId) {
        const prevDoc = await ctx.documentStore.getById(previousVersionId);
        if (!prevDoc) {
          res.status(404).json({ error: 'not_found', message: `previous_version_id ${previousVersionId} not found` });
          return;
        }
      }

      // ── Aspect 1: spam / emptiness screen (openarx-contracts-4pd Phase 1) ──
      // Runs BEFORE disk writes + documentStore.save so that a reject
      // leaves no trace (no storage allocation, no PG row). For the
      // storage_path ingestion mode we only have the abstract + metadata
      // to screen; aspect 1 LLM classifier still runs on title+abstract
      // and the body check is skipped. Spec: contracts/content_review.md §3.
      const sourceTextForGate = body.content_source as Record<string, unknown> | undefined;
      const spamScreenBody: string = typeof sourceTextForGate?.text === 'string'
        ? (sourceTextForGate.text as string).slice(0, 8000)
        : `${title}\n\n${abstract}`;
      const spamResult: SpamScreenResult = await runSpamScreen(
        { title, abstract, body: spamScreenBody },
        { modelRouter: ctx.modelRouter },
      );
      const spamTier: ReportTier = (body.report_tier as ReportTier) === 'basic' ? 'basic' : 'full';
      if (spamResult.verdict === 'reject') {
        res.status(422).json({
          error: 'spam_reject',
          message: 'Submission rejected by content quality screen',
          spam_reasons: spamResult.reasons,
          llm_attempted: spamResult.llmAttempted,
        });
        return;
      }

      // ── Resolve content source ──
      const sourceText = contentSource.text as string | undefined;
      const storagePath = contentSource.storage_path as string | undefined;
      const mainFile = contentSource.main_file as string | undefined;

      if (!sourceText && !storagePath) {
        res.status(400).json({ error: 'validation_error', message: 'content_source must have text or storage_path' });
        return;
      }

      // Determine raw_content_path and source_format
      const coreDocId = randomUUID();
      const userId = body.user_id as string | undefined;
      const docDir = userId
        ? join(PORTAL_STORAGE_BASE, userId, 'indexed', coreDocId)
        : join(PORTAL_STORAGE_BASE, '_core', coreDocId); // legacy fallback
      let rawContentPath = '';
      let sourceFormat: 'pdf' | 'latex' | 'markdown' =
        contentFormat === 'pdf' ? 'pdf'
        : contentFormat === 'markdown' ? 'markdown'
        : 'latex';

      if (sourceText) {
        // Scenario A or C: text provided — write to disk
        const sourceDir = join(docDir, 'source');
        await mkdir(sourceDir, { recursive: true });
        const ext = contentFormat === 'pdf' ? '.pdf' : contentFormat === 'markdown' ? '.md' : '.tex';
        const filename = `main${ext}`;
        rawContentPath = join(sourceDir, filename);
        await writeFile(rawContentPath, sourceText, 'utf-8');
      } else if (storagePath && mainFile) {
        // Scenario B: files on StorageBox
        const attachmentsDir = join(storagePath, 'attachments');
        rawContentPath = join(attachmentsDir, mainFile);
        try {
          await access(rawContentPath, constants.R_OK);
        } catch {
          res.status(400).json({ error: 'file_not_found', message: `Cannot read ${rawContentPath}` });
          return;
        }
      } else {
        res.status(400).json({ error: 'validation_error', message: 'storage_path requires main_file when text is not provided' });
        return;
      }

      // ── Build authors array ──
      const authors: Author[] = authorsRaw.map((a) => ({
        name: [a.given_name, a.family_name].filter(Boolean).join(' ') || (a.name as string) || 'Unknown',
        givenName: (a.given_name as string) ?? undefined,
        familyName: (a.family_name as string) ?? undefined,
        orcid: (a.orcid as string) ?? undefined,
        email: (a.email as string) ?? undefined,
        isCorresponding: (a.is_corresponding as boolean) ?? undefined,
        creditRoles: (a.credit_roles as string[]) ?? undefined,
      }));

      // ── Build code_links, dataset_links, benchmark_results from author-provided data ──
      const codeLinksRaw = (body.code_links as Array<{ url: string; description?: string }>) ?? [];
      const codeLinks: CodeLink[] = codeLinksRaw.map((l) => ({
        repoUrl: l.url,
        extractedFrom: 'author' as const,
      }));

      const datasetLinksRaw = (body.dataset_links as Array<{ name: string; url?: string }>) ?? [];
      const datasetLinks: DatasetLink[] = datasetLinksRaw.map((l) => ({
        name: l.name,
        url: l.url,
        extractedFrom: 'author' as const,
      }));

      const benchmarkLinksRaw = (body.benchmark_links as Array<{ task: string; dataset?: string; metric?: string; score?: string }>) ?? [];
      const benchmarkResults: BenchmarkResult[] = benchmarkLinksRaw.map((b) => ({
        task: b.task,
        dataset: b.dataset ?? '',
        metric: b.metric ?? '',
        score: Number(b.score) || 0,
        extractedFrom: 'author' as const,
      }));

      // ── Build external_ids ──
      const externalIds: Record<string, string> = { portal: portalDocId };
      if (body.doi) externalIds.doi = body.doi as string;
      if (body.arxiv_id) externalIds.arxiv = body.arxiv_id as string;

      // ── Build portal_metadata (rarely-queried fields) ──
      const portalMetadata: Record<string, unknown> = {};
      if (body.funding) portalMetadata.funding = body.funding;
      if (body.coi_statement) portalMetadata.coi_statement = body.coi_statement;
      if (body.data_availability) portalMetadata.data_availability = body.data_availability;
      if (body.data_availability_url) portalMetadata.data_availability_url = body.data_availability_url;
      if (body.related_identifiers) portalMetadata.related_identifiers = body.related_identifiers;

      // ── Create document record ──
      const version = (body.version as number) ?? 1;
      const conceptId = (body.concept_id as string) ?? coreDocId;
      const oarxId = 'oarx-' + createHash('sha256').update(`portal:${portalDocId}`).digest('hex').slice(0, 8);

      const doc: Document = {
        id: coreDocId,
        version,
        createdAt: new Date(),
        previousVersion: previousVersionId,
        oarxId,
        conceptId,
        source: 'portal',
        sourceId: portalDocId,
        sourceUrl: (body.source_url as string) ?? '',
        title,
        authors,
        abstract,
        categories: (body.arxiv_categories as string[]) ?? [],
        publishedAt: new Date(),
        rawContentPath,
        structuredContent: null,
        sources: sourceFormat === 'pdf'
          ? { pdf: { path: rawContentPath } }
          : contentFormat === 'markdown'
            ? { markdown: { path: rawContentPath } }
            : { latex: { path: join(rawContentPath, '..'), rootTex: rawContentPath.split('/').pop() } },
        externalIds,
        license: license,
        keywords: (body.keywords as string[]) ?? undefined,
        language: (body.language as string) ?? 'en',
        resourceType: (body.resource_type as string) ?? 'preprint',
        embargoUntil: body.embargo_until ? new Date(body.embargo_until as string) : undefined,
        portalMetadata: Object.keys(portalMetadata).length > 0 ? portalMetadata : undefined,
        sourceFormat,
        codeLinks,
        datasetLinks,
        benchmarkResults,
        // Portal docs are our own content — author grants indexing at
        // publication; we commit to full indexing regardless of license
        // (product promise, not legal gate). License drives tier only
        // for external-source docs (arxiv etc). See openarx-luco.
        indexingTier: 'full',
        status: 'downloaded',
        processingLog: [{ step: 'ingest-document', status: 'completed', timestamp: new Date().toISOString() }],
        processingCost: 0,
        provenance: [],
        retryCount: 0,
      };

      await ctx.documentStore.save(doc);

      // ── Write initial document_reviews row with aspect 1 (spam-screen)
      //    already populated. Status='pending' lets the pipeline's
      //    review_novelty step (workers.ts) pick it up after index; that
      //    worker flips pending → running → complete once aspect 3
      //    (novelty + grounding) finishes. ──
      try {
        await createInitialReview({
          documentId: coreDocId,
          triggeredBy: 'auto_on_publish',
          spamVerdict: spamResult.verdict,
          spamReasons: spamResult.reasons,
          llmCost: spamResult.llmCost,
          reportTier: spamTier,
          status: 'pending',
        });
      } catch (err) {
        // Review insert failure is non-fatal for publish. Publish still
        // proceeds to queue; aspect 1 result is lost but not catastrophic.
        console.error('[ingest-document] review insert failed:', err instanceof Error ? err.message : err);
      }

      // Enqueue for pipeline processing
      if (ctx.portalDocQueue.isReady) {
        const enqueued = ctx.portalDocQueue.enqueue(doc);
        if (!enqueued) {
          console.error(`[ingest-document] Queue full — ${coreDocId} saved but not enqueued`);
          res.status(503).json({
            error: 'queue_full',
            core_document_id: coreDocId,
            message: 'Processing queue is full. Document saved — will be processed when capacity is available.',
          });
          return;
        }
      }

      console.log(`[ingest-document] Created document ${coreDocId} for portal_document_id=${portalDocId}, version=${version}, format=${contentFormat}`);

      res.status(202).json({
        ok: true,
        core_document_id: coreDocId,
        status: 'queued',
        queue_position: ctx.portalDocQueue.queuePosition(coreDocId),
        message: 'Document queued for processing',
      });
    } catch (err) {
      console.error('[ingest-document] Error:', err instanceof Error ? err.message : err);
      console.error('[ingest-document] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── Content Review endpoints (openarx-contracts-4pd) ─────────

  // POST /api/internal/content-review — trigger review for a document.
  // auto_on_publish: idempotent, returns existing latest row.
  // manual: bumps version to N+1, creates pending row. Phase 1 only
  // supports aspect 1 (already computed at publish), so manual triggers
  // get an empty pending row — full pipeline re-run is Phase 2+.
  router.post('/content-review', async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;
      const documentId = body.document_id as string | undefined;
      const trigger = (body.trigger as string | undefined) ?? 'auto_on_publish';
      if (!documentId) {
        res.status(400).json({ error: 'validation_error', message: 'document_id is required' });
        return;
      }
      if (trigger !== 'auto_on_publish' && trigger !== 'manual') {
        res.status(400).json({ error: 'validation_error', message: 'trigger must be auto_on_publish or manual' });
        return;
      }
      const doc = await ctx.documentStore.getById(documentId);
      // Spec §3.1: tombstoned doc → identical 404 to never-existed.
      // Trigger on a deleted doc would also create a stale review row
      // pointing at content the user can no longer access.
      if (!doc || doc.deletedAt) {
        res.status(404).json({ error: 'document_not_found' });
        return;
      }
      const { review, wasCreated } = await triggerReview(documentId, trigger);
      res.status(200).json({
        review_id: review.id,
        version: review.version,
        status: review.status,
        triggered_by: review.triggeredBy,
        was_created: wasCreated,
      });
    } catch (err) {
      console.error('[content-review POST] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // GET /api/internal/content-review/:documentId[?version=N|all][&user_id=uuid]
  // ownership check: if user_id provided, compares against
  //   documents.portal_metadata->>'uploader_id' OR 'user_id'. 403 on mismatch.
  // tier filtering: if report_tier='basic', strips aspect 2-4 + suggestion
  //   + similar_documents fields. Portal is expected to proxy this for
  //   authenticated publishers — Core's internal endpoint trusts the secret
  //   but still honours the uploader check when user_id is supplied.
  router.get('/content-review/:documentId', async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId ?? '');
      const userId = req.query.user_id as string | undefined;
      const versionParam = (req.query.version as string | undefined) ?? 'latest';
      if (!documentId) {
        res.status(400).json({ error: 'validation_error', message: 'documentId is required' });
        return;
      }

      // Ownership check: when user_id provided, verify via portal_metadata.
      // (Core doesn't maintain a dedicated uploaded_by_user_id column yet;
      // Portal stores uploader identity in portal_metadata on ingest.)
      if (userId) {
        const r = await query<{ meta: Record<string, unknown> | null }>(
          `SELECT portal_metadata AS meta FROM documents WHERE id = $1::uuid`,
          [documentId],
        );
        if (r.rows.length === 0) {
          res.status(404).json({ error: 'document_not_found' });
          return;
        }
        const meta = r.rows[0]?.meta ?? {};
        const ownerId = (meta['uploader_id'] as string | undefined) ?? (meta['user_id'] as string | undefined);
        if (ownerId && ownerId !== userId) {
          res.status(403).json({ error: 'not_owner' });
          return;
        }
      }

      if (versionParam === 'all') {
        const all = await getAllReviewVersions(documentId);
        res.status(200).json({ versions: all });
        return;
      }

      const review = versionParam === 'latest'
        ? await getLatestReview(documentId)
        : await getReviewByVersion(documentId, parseInt(versionParam, 10));

      if (!review) {
        res.status(404).json({ error: 'review_not_found' });
        return;
      }

      // Tier filtering per contract §5.2. Basic returns only a minimal
      // "what was the verdict" bundle; upgrading to full unlocks the
      // aspect-2/3/4 detail and similar_documents. Shape is locked to
      // what Portal mocks against — do not drift without a contract
      // amendment.
      if (review.reportTier === 'basic') {
        const summary = review.spamReasons && review.spamReasons.length > 0
          ? review.spamReasons[0]
          : null;
        const filtered = {
          documentId: review.documentId,
          version: review.version,
          status: review.status,
          reportTier: review.reportTier,
          spamVerdict: review.spamVerdict,
          spamReasonsSummary: summary,
          // overallVerdict is a Phase 4 aggregate; NULL until aspect 4 ships.
          overallVerdict: null,
          upgradeAvailable: true,
        };
        res.status(200).json(filtered);
        return;
      }

      // Full tier: return the complete row. llmCosts stays on the wire
      // here — Portal filters it out on the user-facing proxy; admin
      // callers (X-Internal-Secret) see it directly (contract §5.2).
      res.status(200).json(review);
    } catch (err) {
      console.error('[content-review GET] Error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // PATCH /api/internal/content-review/:documentId/tier
  // body: { tier: 'basic'|'full', idempotency_key: string }
  // Idempotency is in-process (map keyed by idempotency_key) for Phase 1.
  // Production-grade Redis-backed replay store in Phase 2.
  const tierIdempotencyStore = new Map<string, {
    timestamp: number;
    previousTier: ReportTier;
    currentTier: ReportTier;
  }>();
  // Simple TTL cleanup every hour (best-effort — Map holds for process lifetime).
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tierIdempotencyStore) {
      if (now - entry.timestamp > 24 * 60 * 60 * 1000) tierIdempotencyStore.delete(key);
    }
  }, 60 * 60 * 1000).unref?.();

  router.patch('/content-review/:documentId/tier', async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.documentId ?? '');
      if (!documentId) {
        res.status(400).json({ error: 'validation_error', message: 'documentId is required' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const tier = body.tier as ReportTier | undefined;
      const idempotencyKey = body.idempotency_key as string | undefined;
      if (tier !== 'basic' && tier !== 'full') {
        res.status(400).json({ error: 'validation_error', message: "tier must be 'basic' or 'full'" });
        return;
      }
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        res.status(400).json({ error: 'validation_error', message: 'idempotency_key is required' });
        return;
      }

      // Idempotency replay check
      const cached = tierIdempotencyStore.get(idempotencyKey);
      if (cached) {
        res.status(200).json({
          previous_tier: cached.previousTier,
          current_tier: cached.currentTier,
          idempotency_replay: true,
        });
        return;
      }

      const result = await patchLatestReviewTier(documentId, tier);
      tierIdempotencyStore.set(idempotencyKey, {
        timestamp: Date.now(),
        previousTier: result.previousTier,
        currentTier: result.currentTier,
      });
      res.status(200).json({
        previous_tier: result.previousTier,
        current_tier: result.currentTier,
        idempotency_replay: false,
      });
    } catch (err) {
      console.error('[content-review PATCH tier] Error:', err instanceof Error ? err.message : err);
      if (err instanceof Error && err.message.startsWith('no review for')) {
        res.status(404).json({ error: 'review_not_found' });
        return;
      }
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.use('/api/internal', router);
}
