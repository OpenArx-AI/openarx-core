/**
 * PgSourceRegistryStore — Postgres-backed source_registry with in-memory cache.
 *
 * source_registry is configuration, not runtime state: small table (~7 rows
 * seeded by migration 021), rarely modified. The cache is loaded on first
 * access (or via explicit refresh()) and reused for the lifetime of the
 * process. Call refresh() after a manual source_registry edit if you need
 * the new values without a process restart.
 *
 * Architecture: see docs/multi_source_ingest.md §3.1.
 */

import { pool } from '../db/pool.js';
import type { SourceRegistry, SourceRegistryStore } from '@openarx/types';

interface DbRow {
  source_id: string;
  display_name: string;
  base_license: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
  created_at: Date;
}

function mapRow(row: DbRow): SourceRegistry {
  return {
    sourceId: row.source_id,
    displayName: row.display_name,
    baseLicense: row.base_license,
    enabled: row.enabled,
    config: row.config ?? {},
    createdAt: row.created_at,
  };
}

export class PgSourceRegistryStore implements SourceRegistryStore {
  private cache = new Map<string, SourceRegistry>();
  private loaded = false;

  async getSource(sourceId: string): Promise<SourceRegistry | null> {
    if (!this.loaded) await this.refresh();
    return this.cache.get(sourceId) ?? null;
  }

  async listEnabled(): Promise<SourceRegistry[]> {
    if (!this.loaded) await this.refresh();
    return [...this.cache.values()].filter((s) => s.enabled);
  }

  async refresh(): Promise<void> {
    const result = await pool.query<DbRow>(`SELECT * FROM source_registry`);
    this.cache.clear();
    for (const row of result.rows) {
      this.cache.set(row.source_id, mapRow(row));
    }
    this.loaded = true;
  }
}
