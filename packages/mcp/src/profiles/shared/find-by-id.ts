import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { jsonResult, formatDoc } from './helpers.js';
import { resolveOarxIdToDocId } from '../../lib/oarx-resolve.js';

export function registerFindById(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_by_id',
    'Find a paper by any external identifier: OpenArx ID (oarx-…), DOI, arXiv ID, Semantic Scholar Corpus ID, DBLP ID. arXiv-style DOIs (10.48550/arXiv.<id>) are auto-resolved to the underlying arxiv_id even if the doi field is not stored. An identifier resolves to one specific version of a document, not to a mutable current state, so a reference cannot silently come to mean different text.',
    {
      oarx_id: z.string().optional().describe(
        'OpenArx ID (e.g. oarx-f629d9b6a1c2e3d4). Legacy 8-hex ids (oarx-f629d9b6) are also accepted and resolved by prefix.',
      ),
      doi: z.string().optional().describe(
        'DOI (e.g. 10.1234/...). arXiv-style DOIs (10.48550/arXiv.1706.03762) are auto-resolved to arXiv lookup; non-arXiv DOIs require the doi to be present in externalIds.',
      ),
      arxiv_id: z.string().optional().describe('arXiv ID (e.g. 1706.03762)'),
      s2_id: z.string().optional().describe('Semantic Scholar Corpus ID'),
      dblp_id: z.string().optional().describe(
        'DBLP key like "conf/iclr/HuSWALWWC22" or "journals/corr/abs-1706-03762"',
      ),
    },
    async ({ oarx_id, doi, arxiv_id, s2_id, dblp_id }) => {
      if (!oarx_id && !doi && !arxiv_id && !s2_id && !dblp_id) {
        return jsonResult({ error: 'Provide at least one identifier: oarx_id, doi, arxiv_id, s2_id, or dblp_id' });
      }

      // oarx_id lookup via the CANONICAL resolver (shared with the internal by-oarx-id REST
      // route — one source of truth; see lib/oarx-resolve.ts). Listed/deleted docs invisible.
      if (oarx_id) {
        const r = await resolveOarxIdToDocId(ctx.pool, oarx_id);
        if (r.status === 'invalid') {
          return jsonResult({ error: 'Invalid oarx_id format: expected oarx- followed by 16 (or legacy 8) hex chars' });
        }
        if (r.status === 'ok') {
          const doc = await ctx.documentStore.getById(r.docId);
          if (doc && !doc.deletedAt) return jsonResult({ document: formatDoc(doc) });
        }
        return jsonResult({ error: 'Document not found' });
      }

      // BUG-D-01: arXiv DOI shape — derive arxiv_id without storing per-doc.
      // Format: 10.48550/arXiv.<id> (case-insensitive prefix). If user passed
      // such DOI, route through the arxiv lookup path below.
      let derivedArxivId: string | undefined;
      if (doi) {
        const m = /^10\.48550\/arXiv\.(\S+)$/i.exec(doi.trim());
        if (m) derivedArxivId = m[1];
      }
      const effectiveArxivId = arxiv_id ?? derivedArxivId;

      // Soft-delete: identical 404 shape for "deleted" and "never existed"
      // (core_soft_delete_spec §3.1 — callers MUST NOT be able to tell
      // them apart). Both branches fall through to the generic not-found.
      if (effectiveArxivId) {
        const doc = await ctx.documentStore.getBySourceId('arxiv', effectiveArxivId);
        // status='listed' = registry-only row (metadata from listing, never
        // downloaded/indexed) — before the per-document registry these papers
        // were simply absent from the DB, so keep returning not-found.
        if (doc && !doc.deletedAt && doc.status !== 'listed') return jsonResult({ document: formatDoc(doc) });
      }

      const conditions: string[] = [];
      const params: string[] = [];
      if (doi && !derivedArxivId) {
        // Only fall through to external_ids lookup for non-arXiv DOIs.
        params.push(doi);
        conditions.push(`external_ids @> jsonb_build_object('doi', $${params.length}::text)`);
      }
      if (s2_id) { params.push(s2_id); conditions.push(`external_ids @> jsonb_build_object('s2_id', $${params.length}::text)`); }
      if (dblp_id) { params.push(dblp_id); conditions.push(`external_ids @> jsonb_build_object('dblp', $${params.length}::text)`); }
      if (effectiveArxivId && !conditions.length) { params.push(effectiveArxivId); conditions.push(`external_ids @> jsonb_build_object('arxiv', $${params.length}::text)`); }

      if (conditions.length > 0) {
        // Filter deleted_at IS NULL in the initial ID-to-UUID lookup so
        // we never even fetch the row for a tombstoned doc.
        const { rows } = await ctx.pool.query(
          `SELECT id, source_id, title, source_url, external_ids FROM documents
             WHERE (${conditions.join(' OR ')}) AND deleted_at IS NULL
               AND status != 'listed'
             LIMIT 1`,
          params,
        );
        if (rows.length > 0) {
          const doc = await ctx.documentStore.getById(rows[0].id);
          if (doc && !doc.deletedAt) return jsonResult({ document: formatDoc(doc) });
        }
      }

      return jsonResult({ error: 'Document not found' });
    },
  );
}
