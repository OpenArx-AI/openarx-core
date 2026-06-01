/**
 * PgDocumentLocationStore — Postgres-backed storage for document_locations.
 *
 * Schema: see migration 021_source_registry_document_locations.sql.
 * Architecture rationale: see docs/multi_source_ingest.md.
 *
 * Caller surface:
 *   - Ingest writers create the primary location row at document creation
 *     (openarx-745). Invariant: exactly one is_primary=true per document_id
 *     (enforced by partial unique index idx_document_locations_primary).
 *   - Enrichment worker inserts additional non-primary locations as it
 *     discovers OA copies via Unpaywall / OpenAlex / CORE / PMC.
 *   - MCP output gate consults findServableLocation() to decide whether the
 *     full document can be served to clients (openarx-p51d).
 */

import { pool } from '../db/pool.js';
import type {
  DocumentLocation,
  DocumentLocationStore,
  HostType,
  LicenseSource,
  LocationVersion,
} from '@openarx/types';

interface DbRow {
  id: string;
  document_id: string;
  source_id: string;
  source_identifier: string | null;
  source_url: string | null;
  license_raw: string | null;
  license_canonical: string | null;
  license_source: string;
  version: string | null;
  is_primary: boolean;
  is_oa: boolean;
  host_type: string | null;
  file_path: string | null;
  metadata: Record<string, unknown> | null;
  fetched_at: Date | null;
  created_at: Date;
}

function mapRow(row: DbRow): DocumentLocation {
  return {
    id: row.id,
    documentId: row.document_id,
    sourceId: row.source_id,
    sourceIdentifier: row.source_identifier,
    sourceUrl: row.source_url,
    licenseRaw: row.license_raw,
    licenseCanonical: row.license_canonical,
    licenseSource: (row.license_source ?? 'document') as LicenseSource,
    version: (row.version ?? null) as LocationVersion | null,
    isPrimary: row.is_primary,
    isOa: row.is_oa,
    hostType: (row.host_type ?? null) as HostType | null,
    filePath: row.file_path,
    metadata: row.metadata ?? {},
    fetchedAt: row.fetched_at,
    createdAt: row.created_at,
  };
}

export class PgDocumentLocationStore implements DocumentLocationStore {
  async save(loc: Omit<DocumentLocation, 'id' | 'createdAt'>): Promise<DocumentLocation> {
    const result = await pool.query<DbRow>(
      `INSERT INTO document_locations (
         document_id, source_id, source_identifier, source_url,
         license_raw, license_canonical, license_source, version,
         is_primary, is_oa, host_type, file_path, metadata, fetched_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
       RETURNING *`,
      [
        loc.documentId,
        loc.sourceId,
        loc.sourceIdentifier,
        loc.sourceUrl,
        loc.licenseRaw,
        loc.licenseCanonical,
        loc.licenseSource,
        loc.version,
        loc.isPrimary,
        loc.isOa,
        loc.hostType,
        loc.filePath,
        JSON.stringify(loc.metadata ?? {}),
        loc.fetchedAt,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async getByDocumentId(documentId: string): Promise<DocumentLocation[]> {
    const result = await pool.query<DbRow>(
      `SELECT * FROM document_locations
       WHERE document_id = $1
       ORDER BY is_primary DESC, created_at ASC`,
      [documentId],
    );
    return result.rows.map(mapRow);
  }

  async getPrimary(documentId: string): Promise<DocumentLocation | null> {
    const result = await pool.query<DbRow>(
      `SELECT * FROM document_locations
       WHERE document_id = $1 AND is_primary = true
       LIMIT 1`,
      [documentId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findServableLocation(documentId: string): Promise<DocumentLocation | null> {
    // Uses partial index idx_document_locations_oa_file
    // (is_oa = true AND file_path IS NOT NULL).
    const result = await pool.query<DbRow>(
      `SELECT * FROM document_locations
       WHERE document_id = $1
         AND is_oa = true
         AND file_path IS NOT NULL
       ORDER BY is_primary DESC, created_at ASC
       LIMIT 1`,
      [documentId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async deleteByDocumentId(documentId: string): Promise<number> {
    const result = await pool.query(
      `DELETE FROM document_locations WHERE document_id = $1`,
      [documentId],
    );
    return result.rowCount ?? 0;
  }
}
