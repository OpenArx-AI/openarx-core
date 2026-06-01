/**
 * buildEmbedText — single source of truth for the text fed to embedders.
 *
 * Used by both the ingest pipeline (workers.ts) and the metadata-backfill
 * script. Keeping the formula in one place ensures that re-embedded chunks
 * use the same input string format as freshly-ingested ones, so vector
 * geometry stays consistent across the corpus.
 *
 * Includes summary + keyConcept when both are present — these LLM-derived
 * markers add document-level intent that the chunk text alone may not
 * surface (e.g. results chunks where the metric is in a separate table).
 * When either marker is missing, falls back to the structural prefix only.
 */

import type { Chunk } from '@openarx/types';

export function buildEmbedText(chunk: Chunk): string {
  const title = chunk.context.documentTitle || '';
  const section = chunk.context.sectionPath || chunk.context.sectionName || '';
  if (chunk.context.summary && chunk.context.keyConcept) {
    return `${title}. ${section}. [${chunk.context.keyConcept}] ${chunk.context.summary}\n${chunk.content}`;
  }
  return `${title}. ${section}. ${chunk.content}`;
}
