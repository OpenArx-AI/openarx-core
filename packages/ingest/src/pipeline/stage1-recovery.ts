/**
 * stage1-recovery.ts — reconstruct the chunker's batches from a document's STORED
 * sections and recover each chunk's exact source text, EXACTLY replicating the
 * chunker's batch scope — the only granularity with a 0-silent-wrong guarantee
 * (experimenter-validated, ingest_llm_selection; per-document leaks 0.009% silent
 * corruption, per-section fails on multi-section batches).
 *
 * This is the correctness-critical core of Stage-1. The exact reconstruction protocol
 * below is handed to the experimenter to re-validate 0-silent-wrong on real data
 * BEFORE any bulk run.
 */
import type { ParsedSection } from '@openarx/types';
import { sectionsToBatches, batchRawContent } from './section-batching.js';
import { recoverSequence, type RecResult } from './verbatim-recovery.js';

export interface DocChunk {
  /** current (possibly LLM-distorted) chunk text — chunks.content */
  content: string;
  /** section path the chunk belongs to — chunks.section_path */
  sectionPath: string;
  /** ordering within the document — chunks.position */
  position: number;
}

export interface ChunkRecovery<C extends DocChunk> {
  chunk: C;
  result: RecResult;
}

/** Strip an accidental "---SECTION: … ---" wrapper the model sometimes copies into
 *  the `section` label verbatim, and trim. */
export function normalizeSectionLabel(label: string): string {
  return label.replace(/^-{2,}\s*SECTION:\s*/i, '').replace(/\s*-{2,}\s*$/, '').trim();
}

/** The leaf (last " > " hierarchy segment) of a section path — the stable anchor when
 *  the STORED sections are flatter/deeper than the chunk's labelled hierarchy (e.g.
 *  chunk "Fine-tuning > RLHF" vs stored flat section "RLHF"). */
export function sectionLeaf(path: string): string {
  const parts = path.split(' > ');
  return parts[parts.length - 1].trim();
}

/**
 * Protocol:
 *  1. batches = sectionsToBatches(sections) — the same flatten → drop-tiny → group the
 *     chunker ran, so each batch == the exact text the model saw.
 *  2. map each section.path -> the FIRST batch containing it (overlap-carried sections
 *     resolve to their first batch, matching crossBatchDedup which keeps the first).
 *  3. group chunks by their section's batch; within a batch order by `position`;
 *     recoverSequence(chunkTexts, batchRawContent(batch)) per batch (sequential cursor).
 *  4. chunks whose section is not in any batch -> FAILED (unmatched-section): NEVER a
 *     silent overwrite — the caller keeps the original text and marks it.
 *
 * `sections` MUST be the STORED structured_content sections (exactly what the chunker
 * saw), NOT a fresh re-parse — a drifted parser would break the source==batch invariant.
 * Results are returned in the input `chunks` order.
 */
export function reconstructAndRecover<C extends DocChunk>(
  sections: ParsedSection[],
  chunks: C[],
): Array<ChunkRecovery<C>> {
  const batches = sectionsToBatches(sections);
  // Real-data chunk `section` labels are noisier than the reconstructed paths: some
  // carry a literal "---SECTION: … ---" wrapper (the model copied the header), and the
  // stored sections can be flatter than the ingest-time hierarchy (chunk "A > B" vs
  // stored "B"). Match: exact path → normalized path → leaf name. A wrong match still
  // cannot corrupt — recoverSequence's content-boundary check turns it into FAILED.
  const pathToBatch = new Map<string, number>();
  const leafToBatch = new Map<string, number>();
  batches.forEach((batch, bi) => {
    for (const s of batch) {
      if (!pathToBatch.has(s.path)) pathToBatch.set(s.path, bi);
      const leaf = sectionLeaf(s.path);
      if (!leafToBatch.has(leaf)) leafToBatch.set(leaf, bi);
    }
  });
  const batchFor = (rawLabel: string): number | undefined => {
    const norm = normalizeSectionLabel(rawLabel);
    return pathToBatch.get(rawLabel) ?? pathToBatch.get(norm) ?? leafToBatch.get(sectionLeaf(norm));
  };

  const byBatch = new Map<number, C[]>();
  const resultOf = new Map<C, RecResult>();
  for (const c of chunks) {
    const bi = batchFor(c.sectionPath);
    if (bi === undefined) {
      resultOf.set(c, { status: 'FAILED', span: null, text: null, method: 'unmatched-section' });
      continue;
    }
    const arr = byBatch.get(bi);
    if (arr) arr.push(c);
    else byBatch.set(bi, [c]);
  }

  for (const [bi, group] of byBatch) {
    group.sort((a, b) => a.position - b.position);
    const source = batchRawContent(batches[bi]);
    const results = recoverSequence(group.map((c) => c.content), source);
    group.forEach((chunk, i) => resultOf.set(chunk, results[i]));
  }

  // Return in the caller's original chunk order.
  return chunks.map((chunk) => ({
    chunk,
    result: resultOf.get(chunk) ?? { status: 'FAILED', span: null, text: null, method: 'no-result' },
  }));
}
