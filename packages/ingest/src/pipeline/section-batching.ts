/**
 * section-batching.ts — the chunker's section flattening + char-limit batching,
 * extracted as the SINGLE SOURCE OF TRUTH.
 *
 * BOTH the ingest chunker (chunker-step) AND the Stage-1 background re-processing
 * service MUST batch sections IDENTICALLY: verbatim recovery reconstructs each
 * chunk's source EXACTLY as the chunker batched it, and the 0-silent-wrong guarantee
 * holds ONLY when the recovery source == the chunker's batch content (experimenter-
 * validated, ingest_llm_selection). If these two ever diverge, recovery would silently
 * corrupt text — so this is the ONE implementation; do NOT change the batching
 * (BATCH_CHAR_LIMIT / overlap / giant split) without re-validating recovery.
 */
import type { ParsedSection } from '@openarx/types';

export interface FlatSection extends ParsedSection {
  path: string;
}

/** Char budget per chunker batch (sections are grouped up to this).
 *
 *  ★ MEASURED AND REVERTED: raising this to 6000 changed nothing. On a 100-document run the calls
 *  per document stayed at 13.1 (from 13.8) and cost at $0.0500/doc (from $0.0504), while full-text
 *  fallbacks DOUBLED, 2.1% → 5.1% — so the change was very slightly harmful. Effective content per
 *  call stayed ~3560 chars, i.e. batches behaved as if the limit were still 3500, which means this
 *  limit is NOT the binding constraint: the paper's own sections are large enough that one section
 *  already fills a batch (the logs show "Marker batch: 1 sections" / "2 sections"), so there is
 *  nothing left to group. The lever for call count is therefore how sections are SPLIT, not this
 *  ceiling. Do not raise it again without first measuring the section-length distribution.
 *
 *  The original reasoning below still describes the cost structure correctly — it was the proposed
 *  remedy that did not follow from it. Measured on the 2026-07-26
 *  100-document run: 1954 input tokens per call, of which ~875 are the batch content and ~1080 are
 *  the instruction — so the same instruction was re-sent on all 1384 calls, 1.49M tokens, 24% of the
 *  whole chunking input. Fewer, larger batches divide that overhead directly.
 *
 *  NB this does NOT enable Gemini implicit caching, contrary to the obvious guess: caching keys on a
 *  stable PREFIX, and the prefix here is the instruction, which stays ~1080 tokens however large the
 *  batch gets. Bigger batches only grow the variable part. Reaching the 4096-token prefix threshold
 *  needs explicit cache configuration, tracked separately.
 *
 *  The trade-off is truncation: more sections per call means more output per call, and a MAX_TOKENS
 *  cut triggers the pro-model retry at 4x the price — one such retry can undo the saving from dozens
 *  of chunks. 6000 is deliberately moderate rather than maximal; the next run must be checked for
 *  pro-model calls (the last one had zero) and rolled back if they appear. */
export const BATCH_CHAR_LIMIT = 3500;
/** Sections shorter than this (trimmed) are dropped before batching. */
export const MIN_SECTION_CHARS = 30;
/** A section longer than this is split into paragraph sub-sections first.
 *  ~130K chars ≈ 32K tokens — safely under the model output-token limit. */
export const GIANT_SECTION_LIMIT = 130_000;

/** Flatten the section tree depth-first, assigning each a hierarchical `path`. */
export function flattenSections(sections: ParsedSection[], parentPath = ''): FlatSection[] {
  const result: FlatSection[] = [];
  for (const section of sections) {
    const path = parentPath ? `${parentPath} > ${section.name}` : section.name;
    result.push({ ...section, path });
    if (section.subsections?.length) {
      result.push(...flattenSections(section.subsections, path));
    }
  }
  return result;
}

/** Split a giant section into paragraph-based sub-sections, each under the limit. */
function splitGiantSection(section: FlatSection): FlatSection[] {
  const paragraphs = section.content.split(/\n\n+/);
  const parts: FlatSection[] = [];
  let current = '';
  let partIdx = 0;
  for (const para of paragraphs) {
    if (current.length + para.length > GIANT_SECTION_LIMIT && current.length > 0) {
      parts.push({ ...section, content: current.trim(), name: `${section.name} [part ${++partIdx}]`, path: `${section.path} [part ${partIdx}]` });
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim().length > 0) {
    parts.push(parts.length > 0
      ? { ...section, content: current.trim(), name: `${section.name} [part ${++partIdx}]`, path: `${section.path} [part ${partIdx}]` }
      : { ...section, content: current.trim() }); // single part = keep original name
  }
  return parts;
}

/** Group flattened sections into batches: giant-split first, then pack up to
 *  BATCH_CHAR_LIMIT, carrying the last section (≤500 chars) into the next batch as
 *  overlap context. */
export function groupIntoBatches(sections: FlatSection[]): FlatSection[][] {
  const batches: FlatSection[][] = [];
  let current: FlatSection[] = [];
  let currentLen = 0;
  for (const section of sections) {
    const parts = section.content.length > GIANT_SECTION_LIMIT
      ? splitGiantSection(section)
      : [section];
    for (const part of parts) {
      if (currentLen + part.content.length > BATCH_CHAR_LIMIT && current.length > 0) {
        batches.push(current);
        const lastSection = current[current.length - 1];
        if (lastSection.content.length <= 500) {
          current = [lastSection];
          currentLen = lastSection.content.length;
        } else {
          current = [];
          currentLen = 0;
        }
      }
      current.push(part);
      currentLen += part.content.length;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The full chunker pre-prompt pipeline: flatten → drop tiny sections → batch.
 *  Reproduces EXACTLY the batches the chunker fed the model — so Stage-1 recovery
 *  can reconstruct each chunk's source. */
export function sectionsToBatches(sections: ParsedSection[]): FlatSection[][] {
  const flat = flattenSections(sections).filter((s) => s.content.trim().length >= MIN_SECTION_CHARS);
  return groupIntoBatches(flat);
}

/** The verbatim-recovery source for a batch: section contents joined by newline,
 *  WITHOUT the `---SECTION:---` headers the model is shown. Chunks are single-section,
 *  so the join never falls inside a chunk. Matches the experimenter's `rawContent`. */
export function batchRawContent(batch: FlatSection[]): string {
  return batch.map((s) => s.content).join('\n');
}
