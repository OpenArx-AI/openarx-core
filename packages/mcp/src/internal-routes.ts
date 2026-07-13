/**
 * Internal API routes — REST endpoints for Portal (no MCP overhead).
 *
 * Auth: X-Internal-Secret header (shared secret between Core ↔ Portal).
 * Billing: Portal handles credit deduction before calling these endpoints.
 *
 * POST /api/internal/search              — hybrid search with document metadata
 * POST /api/internal/publish-document    — unified publication endpoint (uhlh)
 * GET  /api/internal/documents/:id       — document details
 * GET  /api/internal/documents/:id/pdf   — stream PDF file
 *
 * Legacy POST /api/internal/ingest-document removed 2026-06-13 (l37i,
 * contract §10) — superseded by /publish-document; Portal rewired in o4z2.
 */

import { createReadStream } from 'node:fs';
import { access, constants, stat, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, dirname, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import archiver from 'archiver';

const execFileAsync = promisify(execFile);
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import type { AppContext } from './context.js';
import { handlePublishDocument } from './publish-document.js';
import { handleUserDocuments } from './user-documents.js';
import { resolveConceptLatest } from './concept-latest.js';
import { methodology as methodistMethodology } from './profiles/methodist-v2/assets/content.js';
import type { SearchResult, Document } from '@openarx/types';
import type { BM25Result, ReportTier } from '@openarx/api';
import {
  triggerReview,
  getLatestReview,
  getReviewByVersion,
  getAllReviewVersions,
  patchLatestReviewTier,
  query,
  neoGraphCounts,
  Layer2VectorStore,
} from '@openarx/api';
import { isOpenLicense } from '@openarx/ingest';
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
  // 80mb: Scenario A inline content can reach 2 MB and Portal payloads may
  // carry sizable metadata; the default 100kb silently capped them. The
  // route is X-Internal-Secret-gated, not public.
  router.use(express.json({ limit: '80mb' }));
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

        // Prefer eprint archive when available (lazy-extract policy openarx-yvkp):
        // ingest no longer persists source/ alongside eprint. The archive carries
        // the same data in a more compact form, so we stream it directly to the
        // client. Fallback to legacy zip-on-fly for docs that still have source/
        // but no eprint (older portal-inline submissions, or edge cases).
        const paperDir = dirname(latexPath);
        const eprintPath = join(paperDir, 'eprint');
        let eprintExists = false;
        try { await access(eprintPath, constants.R_OK); eprintExists = true; } catch { /* fall through */ }
        if (eprintExists) {
          res.setHeader('Content-Type', 'application/gzip');
          res.setHeader('Content-Disposition', `attachment; filename="${oarxId}-source.tar.gz"`);
          createReadStream(eprintPath).pipe(res);
          return;
        }

        // Legacy fallback: source/ dir or single .tex still on disk.
        try { await access(latexPath, constants.R_OK); } catch { res.status(404).json({ error: 'file_not_found' }); return; }
        const fileStat = await stat(latexPath);
        if (fileStat.isDirectory()) {
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${oarxId}-source.zip"`);
          const archive = archiver('zip', { zlib: { level: 6 } });
          archive.on('error', (err) => { console.error('[internal/download] Zip error:', err.message); res.status(500).json({ error: 'zip_error' }); });
          archive.pipe(res);
          archive.directory(latexPath, false);
          await archive.finalize();
        } else {
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

  // ── GET /documents/:id/source-file ──────────────────────
  //
  // Extract a single file from the eprint archive on-demand and stream it.
  // Used when callers want main.tex or a specific figure from inside the
  // tarball without downloading the whole bundle. Tmp dir is cleaned up
  // after the response completes (whether by normal flush or client abort).
  //
  // Path is REQUIRED and must be a relative path inside the archive. Path
  // traversal (..) and absolute paths are rejected up-front; after extract,
  // realpath confirms the file stays inside the scratch dir (defends against
  // symlinks embedded in the archive).
  router.get('/documents/:id/source-file', async (req: Request, res: Response) => {
    let tmpDir: string | null = null;
    const cleanup = async (): Promise<void> => {
      if (!tmpDir) return;
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      tmpDir = null;
    };
    try {
      const id = String(req.params.id);
      const requestedPath = req.query.path;
      if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
        res.status(400).json({ error: 'invalid_request', message: 'path query param required' });
        return;
      }
      // Reject path traversal + absolute paths BEFORE we touch the filesystem.
      // normalize() resolves any '..' segments; we forbid the result containing
      // any '..' or starting at root.
      const normalized = normalize(requestedPath);
      if (
        normalized.startsWith(sep) ||
        normalized === '..' ||
        normalized.startsWith('..' + sep) ||
        normalized.split(sep).includes('..')
      ) {
        res.status(400).json({ error: 'path_traversal', message: 'path must be a relative file inside the archive' });
        return;
      }

      const doc = await ctx.documentStore.getById(id);
      if (!doc || doc.deletedAt) {
        res.status(404).json({ error: 'not_found', message: 'Document not found' });
        return;
      }

      const sources = (doc as unknown as Record<string, unknown>).sources as
        Record<string, { path?: string }> | undefined;
      const latexInfo = sources?.latex;
      if (!latexInfo?.path) {
        res.status(404).json({ error: 'not_found', message: 'No LaTeX source for this document' });
        return;
      }
      const eprintPath = join(dirname(latexInfo.path), 'eprint');
      try { await access(eprintPath, constants.R_OK); } catch {
        res.status(404).json({ error: 'not_found', message: 'eprint archive not on disk' });
        return;
      }

      // Cleanup hooks: fire on both normal flush and client disconnect.
      // rm is idempotent (and the closure nulls tmpDir after first run).
      res.on('close', () => { void cleanup(); });
      res.on('finish', () => { void cleanup(); });

      tmpDir = await mkdtemp(join(tmpdir(), 'openarx-serve-'));
      // Full extract is simpler than selective: arXiv tarballs often store
      // entries with a leading "./" prefix, which makes selective extract
      // unreliable across tar implementations. Worst-case ~30 MB per
      // concurrent request — acceptable for an internal serving path.
      try {
        await execFileAsync('tar', ['xzf', eprintPath, '-C', tmpDir]);
      } catch (err) {
        res.status(500).json({ error: 'extract_failed', message: `Could not extract eprint: ${err instanceof Error ? err.message : String(err)}` });
        await cleanup();
        return;
      }

      // Realpath check: after extract, the materialized file must be inside
      // tmpDir. A symlink in the archive pointing outside (e.g. /etc/passwd)
      // would survive selective extract — this check rejects it.
      const extractedPath = join(tmpDir, normalized);
      let resolved: string;
      try {
        resolved = await realpath(extractedPath);
      } catch {
        res.status(404).json({ error: 'not_found', message: 'Extracted file not accessible' });
        await cleanup();
        return;
      }
      const tmpReal = await realpath(tmpDir);
      if (!resolved.startsWith(tmpReal + sep) && resolved !== tmpReal) {
        res.status(400).json({ error: 'symlink_escape', message: 'Refusing to serve file that escapes the archive' });
        await cleanup();
        return;
      }

      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        res.status(400).json({ error: 'not_a_file', message: 'Path resolves to non-regular file' });
        await cleanup();
        return;
      }

      // Inferred content-type by extension; client should not rely on it.
      const lower = normalized.toLowerCase();
      const contentType =
        lower.endsWith('.tex') ? 'application/x-tex; charset=utf-8' :
        lower.endsWith('.bib') ? 'application/x-bibtex; charset=utf-8' :
        lower.endsWith('.pdf') ? 'application/pdf' :
        lower.endsWith('.json') ? 'application/json; charset=utf-8' :
        'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${normalized.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
      createReadStream(resolved).pipe(res);
    } catch (err) {
      console.error('[internal/source-file] Error:', err instanceof Error ? err.message : err);
      await cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    }
  });


  // ── Content Review endpoints (openarx-contracts-4pd) ─────────

  // POST /api/internal/content-review — trigger review for a document.
  // auto_on_publish: idempotent, returns existing latest row.
  // manual: bumps version to N+1, creates pending row. Phase 1 only
  // supports aspect 1 (already computed at publish), so manual triggers
  // get an empty pending row — full pipeline re-run is Phase 2+.
  // ── POST /publish-document — unified publication endpoint (uhlh) ──
  router.post('/publish-document', (req: Request, res: Response) => {
    void handlePublishDocument(req, res, ctx);
  });

  // ── GET /user-documents — paginated user doc list for Portal (amc7) ──
  router.get('/user-documents', (req: Request, res: Response) => {
    void handleUserDocuments(req, res, ctx);
  });

  // (/layer2/user-records REMOVED with the PG-graph teardown — openarx-1woy: it queried the
  //  dropped PG layer2 record tables. Portal portfolio moves to a Neo4j-backed reader.)

  // ── GET /concept-latest — latest version in a concept, owner-scoped. Powers
  //    Portal's §19 stale-parent check (openarx-portal-atrj / bead openarx-yurz). ──
  router.get('/concept-latest', async (req: Request, res: Response) => {
    const conceptId = typeof req.query.concept_id === 'string' ? req.query.concept_id : '';
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : '';
    const { status, body } = await resolveConceptLatest(ctx.pool, conceptId, userId);
    res.status(status).json(body);
  });

  // ── GET /methodist-graph-counts — live cheap graph counts for the Console methodist stats
  //    page (openarx-694n): Neo4j node counts by label + relationship counts by type (native,
  //    ~O(1)) + the Qdrant layer2_claims point count. Heavy claim breakdowns go via the rollup. ──
  router.get('/methodist-graph-counts', async (_req: Request, res: Response) => {
    try {
      const [graph, qdrantCount] = await Promise.all([
        neoGraphCounts(),
        new Layer2VectorStore().countPoints().catch(() => 0),
      ]);
      res.json({ nodes: graph.nodes, edges: graph.edges, qdrant: { layer2_claims: qdrantCount } });
    } catch (e) {
      res.status(500).json({ error: 'methodist_graph_counts_failed', message: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── GET /methodist-version-passport — the deployed methodology's version + structural summary
  //    (Console 694n, A1/A7): methodology_version, procedure names, the _process run-mechanics
  //    (cycle/stage structure, e.g. final_stage_by_cycle), and output-schema names. The PEDAGOGICAL
  //    profile (TRIZ tools/patches/learning-ladder) lives in the methodology CORPUS (prompts._corpus,
  //    unstructured) — the methodist owns that detailed version passport. ──
  router.get('/methodist-version-passport', (_req: Request, res: Response) => {
    const m = methodistMethodology as unknown as {
      methodology_version?: string;
      procedures?: Array<{ name?: string }>;
      schemas?: Record<string, unknown>;
      _process?: unknown;
    };
    res.json({
      methodology_version: m.methodology_version ?? null,
      procedures: (m.procedures ?? []).map((p) => p.name).filter((n): n is string => typeof n === 'string'),
      process: m._process ?? null,
      schemas: Object.keys(m.schemas ?? {}),
    });
  });

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
  // ownership check: if user_id provided, compares against documents.publisher_user_id
  //   (fallback portal_metadata uploader_id/user_id for legacy docs). 403 on mismatch.
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

      // Ownership check: when user_id provided, verify against the canonical
      // owner column publisher_user_id (migration 030) — the SAME source
      // create_draft/create_new_version use — falling back to the legacy
      // portal_metadata uploader_id/user_id only for docs that predate it
      // (openarx-f20i: unify ownership across read + write surfaces).
      if (userId) {
        const r = await query<{ meta: Record<string, unknown> | null; publisher_user_id: string | null }>(
          `SELECT portal_metadata AS meta, publisher_user_id FROM documents WHERE id = $1::uuid`,
          [documentId],
        );
        if (r.rows.length === 0) {
          res.status(404).json({ error: 'document_not_found' });
          return;
        }
        const meta = r.rows[0]?.meta ?? {};
        const ownerId = (r.rows[0]?.publisher_user_id ?? undefined)
          ?? (meta['uploader_id'] as string | undefined)
          ?? (meta['user_id'] as string | undefined);
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
