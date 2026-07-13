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
  if (typeof content?.text === 'string') return content.text;
  return JSON.stringify(rec);
}
