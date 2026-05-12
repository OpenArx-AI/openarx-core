/**
 * Publisher tools — document submission and management via MCP.
 *
 * These tools proxy to Core's internal API endpoints.
 * Available in /pub/mcp profile (min_token_type: publisher).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { query } from '@openarx/api';

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const PORTAL_STORAGE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';

/** Per-user path for Portal indexed docs: {base}/{userId}/indexed/{docId}/ */
function portalDocPath(userId: string, docId: string): string {
  const { join } = require('node:path') as typeof import('node:path');
  return join(PORTAL_STORAGE, userId, 'indexed', docId);
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
    'Submit a document for indexing on OpenArx. Supports LaTeX, Markdown, and PDF formats. Returns a core_document_id for status tracking.',
    {
      title: z.string().describe('Document title'),
      abstract: z.string().describe('Document abstract'),
      content_format: z.enum(['latex', 'markdown', 'pdf']).describe('Content format'),
      content_text: z.string().optional().describe('Document content (inline text for LaTeX/Markdown)'),
      authors: z.array(z.object({
        given_name: z.string(),
        family_name: z.string(),
        orcid: z.string().optional(),
      })).describe('Author list'),
      license: z.string().default('cc-by-4.0').describe('License (e.g. cc-by-4.0)'),
      language: z.string().default('en').describe('Document language (ISO 639-1)'),
      categories: z.array(z.string()).optional().describe('arXiv categories'),
      keywords: z.array(z.string()).optional().describe('Keywords'),
    },
    async ({ title, abstract, content_format, content_text, authors, license, language, categories, keywords }, extra) => {
      // Extract userId from portal token for per-user storage
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      const userId = portalToken?.userId ?? '_anonymous';

      // Build ingest-document payload
      const portalDocId = crypto.randomUUID();
      const payload: Record<string, unknown> = {
        portal_document_id: portalDocId,
        title,
        abstract,
        content_format,
        content_source: { type: 'text', text: content_text ?? '' },
        authors,
        license,
        language,
        arxiv_categories: categories ?? [],
        keywords: keywords ?? [],
      };

      // Save document via documentStore (same as ingest-document endpoint)
      const { createHash, randomUUID } = await import('node:crypto');
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');

      const coreDocId = randomUUID();
      const oarxId = 'oarx-' + createHash('sha256').update(`portal:${portalDocId}`).digest('hex').slice(0, 8);
      const docDir = portalDocPath(userId, coreDocId);
      const sourceDir = join(docDir, 'source');
      await mkdir(sourceDir, { recursive: true });

      const ext = content_format === 'pdf' ? '.pdf' : content_format === 'markdown' ? '.md' : '.tex';
      const filename = `main${ext}`;
      const rawContentPath = join(sourceDir, filename);
      await writeFile(rawContentPath, content_text ?? '', 'utf-8');

      const sourceFormat: 'pdf' | 'latex' | 'markdown' =
        content_format === 'pdf' ? 'pdf'
        : content_format === 'markdown' ? 'markdown'
        : 'latex';
      const sources = sourceFormat === 'pdf'
        ? { pdf: { path: rawContentPath } }
        : content_format === 'markdown'
          ? { markdown: { path: rawContentPath } }
          : { latex: { path: join(rawContentPath, '..'), rootTex: filename } };

      const doc = {
        id: coreDocId,
        version: 1,
        createdAt: new Date(),
        conceptId: coreDocId,
        oarxId,
        source: 'portal' as const,
        sourceId: portalDocId,
        sourceUrl: '',
        title,
        authors: authors.map((a) => ({
          name: `${a.given_name} ${a.family_name}`,
          givenName: a.given_name,
          familyName: a.family_name,
          orcid: a.orcid,
        })),
        abstract,
        categories: categories ?? [],
        publishedAt: new Date(),
        rawContentPath,
        structuredContent: null as unknown,
        sources,
        sourceFormat,
        externalIds: { portal: portalDocId } as Record<string, string>,
        license,
        keywords,
        language,
        resourceType: 'preprint' as const,
        codeLinks: [] as Array<{ repoUrl: string; extractedFrom: 'author' }>,
        datasetLinks: [] as Array<{ name: string; extractedFrom: 'author' }>,
        benchmarkResults: [] as Array<{ task: string; dataset: string; metric: string; score: number; extractedFrom: 'author' }>,
        status: 'downloaded' as const,
        processingLog: [{ step: 'submit_document', status: 'completed' as const, timestamp: new Date().toISOString() }],
        processingCost: 0,
        provenance: [] as Array<{ op: string; at: string; commit: string }>,
        retryCount: 0,
      };

      await ctx.documentStore.save(doc as Parameters<typeof ctx.documentStore.save>[0]);

      // Enqueue for processing
      if (ctx.portalDocQueue.isReady) {
        ctx.portalDocQueue.enqueue(doc as Parameters<typeof ctx.portalDocQueue.enqueue>[0]);
      }

      return jsonResult({
        core_document_id: coreDocId,
        oarx_id: oarxId,
        status: 'queued',
        message: 'Document submitted for indexing',
      });
    },
  );

  // ── get_my_documents ─────────────────────────────────────

  server.tool(
    'get_my_documents',
    'List documents you have submitted through OpenArx Portal.',
    {
      limit: z.number().int().min(1).max(50).default(20).describe('Max results'),
      status: z.enum(['all', 'ready', 'downloaded', 'failed']).default('all').describe('Filter by status'),
    },
    async ({ limit, status }, extra) => {
      // Get portal_user_id from auth context
      const req = extra as unknown as Record<string, unknown>;
      const portalToken = (req as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      // Fallback: query by source='portal'
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
    'Check the processing status of a submitted document.',
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
    'Submit a new version of an existing document. The previous version\'s chunks will be marked as not-latest.',
    {
      previous_document_id: z.string().describe('Core document ID of the previous version'),
      title: z.string().describe('Updated title'),
      abstract: z.string().describe('Updated abstract'),
      content_format: z.enum(['latex', 'markdown', 'pdf']).describe('Content format'),
      content_text: z.string().optional().describe('Updated document content'),
      authors: z.array(z.object({
        given_name: z.string(),
        family_name: z.string(),
        orcid: z.string().optional(),
      })).describe('Author list'),
      license: z.string().default('cc-by-4.0').describe('License'),
    },
    async ({ previous_document_id, title, abstract, content_format, content_text, authors, license }, extra) => {
      const prevDoc = await ctx.documentStore.getById(previous_document_id);
      if (!prevDoc) return jsonResult({ error: 'not_found', message: 'Previous document not found' });

      // Extract userId from portal token for per-user storage
      const portalToken = (extra as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
      const userId = portalToken?.userId ?? '_anonymous';

      const conceptId = (prevDoc as unknown as Record<string, unknown>).conceptId as string ?? prevDoc.id;
      const newVersion = prevDoc.version + 1;

      // Reuse submit_document logic via internal endpoint
      const portalDocId = crypto.randomUUID();
      const { createHash, randomUUID } = await import('node:crypto');
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');

      const coreDocId = randomUUID();
      const oarxId = 'oarx-' + createHash('sha256').update(`portal:${portalDocId}`).digest('hex').slice(0, 8);
      const docDir = portalDocPath(userId, coreDocId);
      const sourceDir = join(docDir, 'source');
      await mkdir(sourceDir, { recursive: true });

      const ext = content_format === 'pdf' ? '.pdf' : content_format === 'markdown' ? '.md' : '.tex';
      const filename = `main${ext}`;
      const rawContentPath = join(sourceDir, filename);
      await writeFile(rawContentPath, content_text ?? '', 'utf-8');

      const sourceFormat: 'pdf' | 'latex' | 'markdown' =
        content_format === 'pdf' ? 'pdf'
        : content_format === 'markdown' ? 'markdown'
        : 'latex';
      const sources = sourceFormat === 'pdf'
        ? { pdf: { path: rawContentPath } }
        : content_format === 'markdown'
          ? { markdown: { path: rawContentPath } }
          : { latex: { path: join(rawContentPath, '..'), rootTex: filename } };

      const doc = {
        id: coreDocId,
        version: newVersion,
        createdAt: new Date(),
        previousVersion: previous_document_id,
        conceptId,
        oarxId,
        source: 'portal' as const,
        sourceId: portalDocId,
        sourceUrl: '',
        title,
        authors: authors.map((a) => ({
          name: `${a.given_name} ${a.family_name}`,
          givenName: a.given_name,
          familyName: a.family_name,
          orcid: a.orcid,
        })),
        abstract,
        categories: prevDoc.categories,
        publishedAt: new Date(),
        rawContentPath,
        structuredContent: null as unknown,
        sources,
        sourceFormat,
        externalIds: { portal: portalDocId } as Record<string, string>,
        license,
        codeLinks: [] as Array<{ repoUrl: string; extractedFrom: 'author' }>,
        datasetLinks: [] as Array<{ name: string; extractedFrom: 'author' }>,
        benchmarkResults: [] as Array<{ task: string; dataset: string; metric: string; score: number; extractedFrom: 'author' }>,
        status: 'downloaded' as const,
        processingLog: [{ step: 'create_new_version', status: 'completed' as const, timestamp: new Date().toISOString() }],
        processingCost: 0,
        provenance: [] as Array<{ op: string; at: string; commit: string }>,
        retryCount: 0,
      };

      await ctx.documentStore.save(doc as Parameters<typeof ctx.documentStore.save>[0]);

      if (ctx.portalDocQueue.isReady) {
        ctx.portalDocQueue.enqueue(doc as Parameters<typeof ctx.portalDocQueue.enqueue>[0]);
      }

      return jsonResult({
        core_document_id: coreDocId,
        oarx_id: oarxId,
        version: newVersion,
        concept_id: conceptId,
        previous_version_id: previous_document_id,
        status: 'queued',
        message: `Version ${newVersion} submitted for indexing`,
      });
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
}
