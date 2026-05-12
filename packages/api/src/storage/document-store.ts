import type {
  DeletionReason,
  Document,
  DocumentStatus,
  DocumentStore,
  ProcessingLogEntry,
  ProvenanceEntry,
} from '@openarx/types';
import { query } from '../db/pool.js';

interface DocumentRow {
  id: string;
  version: number;
  created_at: Date;
  previous_version: string | null;
  concept_id: string | null;
  source: string;
  source_id: string;
  source_url: string | null;
  oarx_id: string | null;
  title: string;
  authors: unknown;
  abstract: string | null;
  categories: string[];
  published_at: Date | null;
  raw_content_path: string | null;
  structured_content: unknown;
  code_links: unknown;
  dataset_links: unknown;
  benchmark_results: unknown;
  extracted_metadata: unknown;
  sources: unknown;
  source_format: string | null;
  status: DocumentStatus;
  processing_log: unknown;
  processing_cost: string; // NUMERIC comes as string from pg
  provenance: unknown;
  external_ids: unknown;
  retry_count: number;
  // Portal metadata
  license: string | null;
  licenses: unknown;
  indexing_tier: string | null;
  keywords: string[] | null;
  language: string | null;
  resource_type: string | null;
  embargo_until: Date | null;
  portal_metadata: unknown;
  // Translation
  original_title: string | null;
  original_abstract: string | null;
  // Soft-delete (migration 027)
  deleted_at: Date | null;
  deletion_reason: string | null;
  deletion_memo: string | null;
  deleted_by: string | null;
  deletion_notice_ref: string | null;
  last_seen_at: Date | null;
}

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    previousVersion: row.previous_version ?? undefined,
    conceptId: row.concept_id ?? undefined,
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url ?? '',
    oarxId: row.oarx_id ?? undefined,
    title: row.title,
    authors: row.authors as Document['authors'],
    abstract: row.abstract ?? '',
    categories: row.categories,
    publishedAt: row.published_at ?? new Date(),
    rawContentPath: row.raw_content_path ?? '',
    structuredContent: row.structured_content,
    extractedMetadata: (row.extracted_metadata as Document['extractedMetadata']) ?? undefined,
    sources: (row.sources as Document['sources']) ?? undefined,
    sourceFormat: (row.source_format as Document['sourceFormat']) ?? undefined,
    codeLinks: row.code_links as Document['codeLinks'],
    datasetLinks: row.dataset_links as Document['datasetLinks'],
    benchmarkResults: row.benchmark_results as Document['benchmarkResults'],
    status: row.status,
    processingLog: row.processing_log as ProcessingLogEntry[],
    processingCost: Number(row.processing_cost),
    provenance: (row.provenance as ProvenanceEntry[]) ?? [],
    externalIds: (row.external_ids as Record<string, string>) ?? {},
    retryCount: row.retry_count ?? 0,
    // Portal metadata + license
    license: row.license ?? undefined,
    licenses: (row.licenses as Record<string, string>) ?? undefined,
    indexingTier: (row.indexing_tier as Document['indexingTier']) ?? undefined,
    keywords: row.keywords ?? undefined,
    language: row.language ?? undefined,
    resourceType: row.resource_type ?? undefined,
    embargoUntil: row.embargo_until ?? undefined,
    portalMetadata: (row.portal_metadata as Record<string, unknown>) ?? undefined,
    // Translation
    originalTitle: row.original_title ?? undefined,
    originalAbstract: row.original_abstract ?? undefined,
    // Soft-delete
    deletedAt: row.deleted_at,
    deletionReason: (row.deletion_reason as DeletionReason | null) ?? null,
    deletionMemo: row.deletion_memo,
    deletedBy: row.deleted_by,
    deletionNoticeRef: row.deletion_notice_ref,
    lastSeenAt: row.last_seen_at,
  };
}

export class PgDocumentStore implements DocumentStore {
  async save(doc: Document): Promise<void> {
    await query(
      `INSERT INTO documents (
        id, version, source, source_id, source_url,
        title, authors, abstract, categories, published_at,
        raw_content_path, structured_content,
        code_links, dataset_links, benchmark_results,
        extracted_metadata, sources, source_format,
        status, processing_log, processing_cost, provenance, external_ids, oarx_id, retry_count,
        concept_id,
        license, licenses, indexing_tier,
        keywords, language, resource_type, embargo_until, portal_metadata,
        original_title, original_abstract
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25,
        $26,
        $27, $28::jsonb, $29,
        $30, $31, $32, $33, $34,
        $35, $36
      )
      ON CONFLICT (source, source_id, version) DO UPDATE SET
        title = EXCLUDED.title,
        authors = EXCLUDED.authors,
        abstract = EXCLUDED.abstract,
        categories = EXCLUDED.categories,
        published_at = EXCLUDED.published_at,
        raw_content_path = EXCLUDED.raw_content_path,
        structured_content = EXCLUDED.structured_content,
        code_links = EXCLUDED.code_links,
        dataset_links = EXCLUDED.dataset_links,
        benchmark_results = EXCLUDED.benchmark_results,
        extracted_metadata = EXCLUDED.extracted_metadata,
        sources = EXCLUDED.sources,
        source_format = EXCLUDED.source_format,
        status = EXCLUDED.status,
        processing_log = EXCLUDED.processing_log,
        processing_cost = EXCLUDED.processing_cost,
        provenance = EXCLUDED.provenance,
        external_ids = EXCLUDED.external_ids,
        oarx_id = EXCLUDED.oarx_id,
        retry_count = EXCLUDED.retry_count,
        concept_id = EXCLUDED.concept_id,
        license = EXCLUDED.license,
        licenses = EXCLUDED.licenses,
        indexing_tier = EXCLUDED.indexing_tier,
        keywords = EXCLUDED.keywords,
        language = EXCLUDED.language,
        resource_type = EXCLUDED.resource_type,
        embargo_until = EXCLUDED.embargo_until,
        portal_metadata = EXCLUDED.portal_metadata,
        original_title = EXCLUDED.original_title,
        original_abstract = EXCLUDED.original_abstract`,
      [
        doc.id,
        doc.version,
        doc.source,
        doc.sourceId,
        doc.sourceUrl,
        doc.title,
        JSON.stringify(doc.authors),
        doc.abstract,
        doc.categories,
        doc.publishedAt,
        doc.rawContentPath,
        doc.structuredContent ? JSON.stringify(doc.structuredContent) : null,
        JSON.stringify(doc.codeLinks),
        JSON.stringify(doc.datasetLinks),
        JSON.stringify(doc.benchmarkResults),
        doc.extractedMetadata ? JSON.stringify(doc.extractedMetadata) : '{}',
        doc.sources ? JSON.stringify(doc.sources) : '{}',
        doc.sourceFormat ?? null,
        doc.status,
        JSON.stringify(doc.processingLog),
        doc.processingCost,
        JSON.stringify(doc.provenance ?? []),
        JSON.stringify(doc.externalIds ?? {}),
        doc.oarxId ?? null,
        doc.retryCount ?? 0,
        doc.conceptId ?? doc.id,  // default: each document is its own concept
        doc.license ?? null,
        JSON.stringify(doc.licenses ?? {}),
        doc.indexingTier ?? 'full',
        doc.keywords ?? null,
        doc.language ?? null,
        doc.resourceType ?? null,
        doc.embargoUntil ?? null,
        doc.portalMetadata ? JSON.stringify(doc.portalMetadata) : '{}',
        doc.originalTitle ?? null,
        doc.originalAbstract ?? null,
      ],
    );
  }

  async getById(id: string): Promise<Document | null> {
    const result = await query<DocumentRow>(
      'SELECT * FROM documents WHERE id = $1',
      [id],
    );
    return result.rows[0] ? rowToDocument(result.rows[0]) : null;
  }

  async getBySourceId(
    source: string,
    sourceId: string,
  ): Promise<Document | null> {
    const result = await query<DocumentRow>(
      'SELECT * FROM documents WHERE source = $1 AND source_id = $2 ORDER BY version DESC LIMIT 1',
      [source, sourceId],
    );
    return result.rows[0] ? rowToDocument(result.rows[0]) : null;
  }

  async listByStatus(
    status: DocumentStatus,
    limit: number,
  ): Promise<Document[]> {
    const result = await query<DocumentRow>(
      'SELECT * FROM documents WHERE status = $1 ORDER BY created_at ASC LIMIT $2',
      [status, limit],
    );
    return result.rows.map(rowToDocument);
  }

  async updateStatus(
    id: string,
    status: DocumentStatus,
    log?: ProcessingLogEntry,
  ): Promise<void> {
    if (log) {
      await query(
        `UPDATE documents
         SET status = $1, processing_log = processing_log || $2::jsonb
         WHERE id = $3`,
        [status, JSON.stringify([log]), id],
      );
    } else {
      await query('UPDATE documents SET status = $1 WHERE id = $2', [
        status,
        id,
      ]);
    }
  }
}
