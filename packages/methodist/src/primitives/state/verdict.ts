/** The verdict vocabulary, read tolerantly but never guessed at.
 *
 * A model returns `"RETURN"` on one call and `"return"` on the next: the schema constrains the
 * SHAPE of the answer, not the spelling of a string inside it. Comparisons here were
 * case-sensitive, so a lowercase verdict matched neither branch, fell through, and the checkpoint
 * reported success while advancing nothing — the same silent failure as before, moved down from the
 * field to its value. (Observed 2026-07-27: "RETURN" and "GO" worked, "return" three calls later
 * did not.)
 *
 * So: accept any casing and surrounding whitespace, and return undefined for anything that is not a
 * verdict at all. Callers that decide on the verdict must treat undefined-but-present as an ERROR,
 * never as "no verdict, carry on" — an unrecognised value means the grader said something we failed
 * to understand, which is exactly the case that must be loud.
 */
export type VerdictValue = 'GO' | 'RETURN';

export function normaliseVerdict(v: unknown): VerdictValue | undefined {
  const raw = typeof v === 'string' ? v : typeof v === 'object' && v !== null ? (v as { verdict?: unknown }).verdict : undefined;
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  return upper === 'GO' || upper === 'RETURN' ? upper : undefined;
}

/** True when a verdict was supplied in some form but is not one we recognise — the case that must
 *  raise rather than fall through. Absent is not the same as unrecognised: absent is handled by the
 *  schema's required-key check upstream. */
export function isUnrecognisedVerdict(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  const raw = typeof v === 'string' ? v : (v as { verdict?: unknown }).verdict;
  if (raw === undefined || raw === null) return false;
  return normaliseVerdict(v) === undefined;
}
