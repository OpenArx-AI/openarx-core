export const QWEN_DIM = 768;

/**
 * Canonical qwen3-embedding-8b vector recipe — the SINGLE source of truth, applied
 * IDENTICALLY to every backend (OpenRouter + rented-GPU TEI) so the same chunk yields the
 * same vector whichever backend served it. This is contracts anchor §1/F1 (prod-schema
 * consistency): if the two backends diverged, the 768-slot / cosine / dedup / methodist
 * revalidation would all break.
 *
 * Recipe = truncate to the first QWEN_DIM dims (Matryoshka/MRL) THEN L2-normalize, matching
 * the experimenter's validated reference (cross-cosine 0.99997 TEI↔OpenRouter) and the
 * methodist sample. NB: L2 must happen AFTER truncation, on the client — server-side
 * truncation would normalize over the native 4096 and diverge. Do NOT change without
 * re-validating the golden vectors.
 */
export function qwenPostprocess(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length < QWEN_DIM) {
    throw new Error(`qwen vector dim ${Array.isArray(vector) ? vector.length : 'non-array'} < ${QWEN_DIM}`);
  }
  const out = vector.length > QWEN_DIM ? vector.slice(0, QWEN_DIM) : vector.slice();
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  }
  return out;
}
