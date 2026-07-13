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

/**
 * Source-text accessibility — the SECOND axis, ORTHOGONAL to indexingTier
 * (whether the full text is indexed and retrievable via get_chunks). It answers
 * "how can the raw source be obtained", which agents previously conflated with
 * content availability via canServeFile (openarx-5xve):
 *   - 'served_by_us'       — we may deliver the raw PDF/source (open/permissive license)
 *   - 'external_link_only' — license blocks US redistributing the file, but the
 *                            source URL is public, so the agent can self-fetch it
 *   - 'unavailable'        — no deliverable file and no source URL
 * The license gates OUR redistribution of the file, NOT linking to it. Only
 * 'unavailable' means the source is genuinely unreachable; full text may still
 * be read via get_chunks when indexingTier='full'.
 */
export type SourceAccessibility = 'unavailable' | 'served_by_us' | 'external_link_only';

export function computeSourceAccessibility(doc: Document): SourceAccessibility {
  if (computeCanServeFile(doc)) return 'served_by_us';
  if (doc.sourceUrl) return 'external_link_only';
  return 'unavailable';
}

/**
 * Effective indexing tier, including 'none' for documents with no indexed body.
 * Conservative: a tier-stamped doc keeps its tier; a null-tier doc that has
 * chunks is treated as 'full' (legacy default); only a doc with no tier AND no
 * chunks reports 'none'. chunkCount must be the total is_latest chunk count.
 */
export function effectiveIndexingTier(
  doc: Document,
  chunkCount: number,
): 'none' | 'abstract_only' | 'full' {
  if (doc.indexingTier === 'abstract_only') return 'abstract_only';
  if (doc.indexingTier === 'full') return 'full';
  return chunkCount > 0 ? 'full' : 'none';
}

/**
 * Surface to clients WHY a document is at abstract_only tier. Lets agents
 * distinguish 'still being processed' from 'legally cannot be indexed beyond
 * abstract' — different actions are appropriate (wait vs use external source).
 *
 * Classification logic:
 *   - tier=full → null (no limitation)
 *   - tier=abstract_only + non-open license → 'license' (intentional compliance gate)
 *   - tier=abstract_only + open/unknown license + status=ready → 'pipeline'
 *     (unexpected; pipeline produced abstract_only despite open license)
 *   - tier=abstract_only + status!=ready → 'pending' (still being processed)
 */
export interface IndexingLimitation {
  limitedBy: 'license' | 'pipeline' | 'pending';
  note: string;
}

export function computeIndexingLimitation(doc: Document): IndexingLimitation | null {
  const tier = doc.indexingTier ?? 'full';
  if (tier === 'full') return null;

  const license = doc.license;
  if (license && license !== 'NOASSERTION' && !isOpenLicense(license as SpdxLicense)) {
    return {
      limitedBy: 'license',
      note: `${license} restricts derivative works or commercial use; only the abstract is indexable under fair-use carve-outs. Full text available at the source URL.`,
    };
  }

  // tier is abstract_only but license is open/unknown — either pipeline isn't
  // finished yet, or it ran and produced abstract_only for some non-license reason.
  if (doc.status !== 'ready') {
    return {
      limitedBy: 'pending',
      note: `Document is still being processed (status=${doc.status}); full text will become available after the pipeline finishes.`,
    };
  }
  return {
    limitedBy: 'pipeline',
    note: 'Document was processed but full-text extraction is unavailable for this paper. This is unexpected for an open-license document — report if persistent.',
  };
}

export function formatDoc(doc: Document, chunkCount?: number): Record<string, unknown> {
  const limitation = computeIndexingLimitation(doc);
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
    // Two orthogonal availability axes (openarx-5xve):
    //   indexingTier        — is the full text indexed & retrievable via get_chunks
    //   sourceAccessibility — how the raw source file can be obtained
    indexingTier:
      chunkCount !== undefined ? effectiveIndexingTier(doc, chunkCount) : (doc.indexingTier ?? 'full'),
    sourceAccessibility: computeSourceAccessibility(doc),
    ...(chunkCount !== undefined ? { chunkCount } : {}),
    // DEPRECATED: gates raw-PDF delivery via our service ONLY; NOT a content
    // availability signal. Equivalent to sourceAccessibility==='served_by_us'.
    // Use sourceAccessibility instead. Removal tracked in openarx-5xve phase 2.
    canServeFile: computeCanServeFile(doc),
    indexingLimitedBy: limitation?.limitedBy ?? null,
    indexingLimitedNote: limitation?.note ?? null,
  };
}
