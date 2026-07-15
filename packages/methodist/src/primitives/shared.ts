// Shared helpers for the record-flow primitives (validate/canonicalize/detect/
// apply-supersede-guards/compute-hash). The methodology threads a records array
// through bare slot refs ($resolved → $canon → $guarded); each step's output is an
// object, so the next step receives the WRAPPER. This tolerant extractor pulls the
// array out whether it arrives as a bare array, {records_resolved}, or {records}.

export interface RecordEntry {
  record_type: string;
  record: Record<string, unknown>;
  [k: string]: unknown;
}

export function asRecordArray(input: unknown): RecordEntry[] {
  if (Array.isArray(input)) return input as RecordEntry[];
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (Array.isArray(o.records_resolved)) return o.records_resolved as RecordEntry[];
    if (Array.isArray(o.records)) return o.records as RecordEntry[];
  }
  return [];
}

/** Best-effort text of a record for language detection / embedding. */
export function recordText(entry: RecordEntry): string {
  const rec = (entry.record ?? entry) as Record<string, unknown>;
  const content = rec.content as Record<string, unknown> | undefined;
  const parts: string[] = [];
  if (typeof content?.text === 'string') parts.push(content.text);
  // A relation's citation_context is human-readable prose AND in the §4.3 hash-scope, so the
  // english-only language gate must see it too (contracts §7.6 ruling 2026-07-13). Used only by
  // detect-language — safe to include here without touching any embedding projection.
  if (typeof rec.citation_context === 'string') parts.push(rec.citation_context);
  if (parts.length > 0) return parts.join('\n');
  return JSON.stringify(rec);
}
