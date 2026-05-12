/**
 * Pure functions used by migrate-embeddings.ts.
 *
 * Kept separate so unit tests can import without triggering the script's
 * main() side-effects.
 *
 * CRITICAL: buildEmbedInput MUST stay byte-for-byte identical to the
 * embed-input construction in packages/ingest/src/pipeline/workers.ts
 * (embedGeminiWorker + embedSpecterWorker). Same input string → same
 * vector from the model → same search quality after migration.
 */

export interface MigrationChunkContext {
  documentTitle?: string;
  sectionPath?: string;
  sectionName?: string;
  summary?: string;
  keyConcept?: string;
}

export interface MigrationChunkRow {
  id: string;
  qdrant_point_id: string;
  content: string;
  context: MigrationChunkContext;
}

export function buildEmbedInput(row: MigrationChunkRow): string {
  const ctx = row.context ?? {};
  const title = ctx.documentTitle ?? '';
  const section = ctx.sectionPath ?? ctx.sectionName ?? '';
  if (ctx.summary && ctx.keyConcept) {
    return `${title}. ${section}. [${ctx.keyConcept}] ${ctx.summary}\n${row.content}`;
  }
  return `${title}. ${section}. ${row.content}`;
}

export function splitBatches<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}
