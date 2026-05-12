/**
 * Append-only provenance log for documents.
 *
 * Each call atomically appends one entry to the provenance JSONB array.
 * Never overwrites — only appends.
 */

import { query } from '@openarx/api';
import type { ProvenanceEntry } from '@openarx/types';
import { BUILD_COMMIT } from './build-info.js';

export async function appendProvenance(
  documentId: string,
  entry: Omit<ProvenanceEntry, 'at' | 'commit'>,
): Promise<void> {
  const full: ProvenanceEntry = {
    ...entry,
    at: new Date().toISOString(),
    commit: BUILD_COMMIT,
  };
  await query(
    `UPDATE documents SET provenance = COALESCE(provenance, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify([full]), documentId],
  );
}
