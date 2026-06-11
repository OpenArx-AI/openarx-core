/**
 * oarx_id — deterministic platform identifier for documents (openarx-pc98).
 *
 * Format: 'oarx-' + first 16 hex chars of sha256('<source>:<source_id>')
 * = 21 chars total (documents.oarx_id VARCHAR(21), migration 029).
 *
 * 16 hex = 64 bits: birthday collisions are negligible at any realistic
 * corpus size (~3e-6 expected pairs at 10M docs). The previous 8-hex form
 * (32 bits) collided at ~1M docs — 33 real pairs were hit during the 2025
 * registry backfill, which forced this widening.
 *
 * Prefix compatibility: the legacy 8-hex id is a PREFIX of the new 16-hex
 * id (same sha256, longer slice). Legacy ids are preserved per-document in
 * external_ids.oarx_legacy and resolvable via left(oarx_id, 13) lookup.
 * For the ~85 legacy collision pairs the legacy id is ambiguous by nature.
 *
 * This is THE single source of the formula — do not re-implement it
 * (history: it was duplicated in arxiv-source, RunnerService and
 * listed-registry, plus 'portal:' variants in mcp).
 */
import { createHash } from 'node:crypto';

export const OARX_ID_HEX_LENGTH = 16;
export const LEGACY_OARX_ID_HEX_LENGTH = 8;

/** New-format id: oarx- + 16 hex. */
export const OARX_ID_RE = /^oarx-[0-9a-f]{16}$/;
/** Legacy-format id (pre-migration-029): oarx- + 8 hex. */
export const LEGACY_OARX_ID_RE = /^oarx-[0-9a-f]{8}$/;

export function computeOarxId(source: string, sourceId: string): string {
  return 'oarx-' + createHash('sha256')
    .update(`${source}:${sourceId}`)
    .digest('hex')
    .slice(0, OARX_ID_HEX_LENGTH);
}
