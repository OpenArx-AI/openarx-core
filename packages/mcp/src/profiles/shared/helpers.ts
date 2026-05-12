import type { SearchResult, Document } from '@openarx/types';
import type { AppContext } from '../../context.js';
import { isOpenLicense } from '@openarx/ingest';
import type { SpdxLicense } from '@openarx/ingest';
import { recordEmbed } from '../../lib/usage-tracker.js';

export function deduplicateByDocument(results: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = best.get(r.documentId);
    if (!existing || r.score > existing.score) {
      best.set(r.documentId, r);
    }
  }
  return [...best.values()];
}

export async function fetchDocuments(
  ids: string[],
  ctx: AppContext,
): Promise<Map<string, Document>> {
  const docs = new Map<string, Document>();
  const results = await Promise.all(
    ids.map((id) => ctx.documentStore.getById(id)),
  );
  // Soft-deleted docs are filtered out at this layer so any retrieval
  // surface that enriches via fetchDocuments (search, find-related,
  // find-code) naturally drops them from enriched results, even if the
  // upstream vector-store filter had a stale `deleted` payload
  // (e.g. mid-reconciliation). See core_soft_delete_spec §3.1.
  for (const doc of results) {
    if (doc && !doc.deletedAt) docs.set(doc.id, doc);
  }
  return docs;
}

export async function embedQuery(
  query: string,
  vectorModel: string,
  ctx: AppContext,
): Promise<{ vector: number[]; vectorName: string }> {
  if (vectorModel === 'specter2') {
    const resp = await ctx.embedClient.callEmbed([query], 'specter2', { timeoutMs: 300_000 });
    recordEmbed(resp);
    return { vector: resp.vectors[0], vectorName: 'specter2' };
  }
  const resp = await ctx.geminiEmbedder.embed([query]);
  recordEmbed(resp);
  return { vector: resp.vectors[0], vectorName: 'gemini' };
}

const MAX_CHUNK_DISPLAY = 800;

export function truncateChunk(text: string): string {
  if (text.length <= MAX_CHUNK_DISPLAY) return text;
  return text.slice(0, MAX_CHUNK_DISPLAY) + '...';
}

export function jsonResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function computeCanServeFile(doc: Document): boolean {
  if (!doc.license || doc.license === 'NOASSERTION') return true; // permissive default
  return isOpenLicense(doc.license as SpdxLicense);
}

export function formatDoc(doc: Document): Record<string, unknown> {
  return {
    id: doc.id,
    title: doc.title,
    authors: doc.authors,
    abstract: doc.abstract,
    categories: doc.categories,
    publishedAt: doc.publishedAt,
    sourceUrl: doc.sourceUrl,
    sourceId: doc.sourceId,
    externalIds: doc.externalIds,
    codeLinks: doc.codeLinks,
    datasetLinks: doc.datasetLinks,
    license: doc.license ?? null,
    licenses: doc.licenses ?? {},
    indexingTier: doc.indexingTier ?? 'full',
    canServeFile: computeCanServeFile(doc),
  };
}
