/**
 * Shared helper: build the JSONB blob stored in documents.structured_content.
 *
 * Written by the chunker when chunks are first persisted (openarx-q2eh), so
 * that on resume the enricher/indexer can reconstruct a ParsedDocument without
 * re-running parse+chunk.
 */

import type { ParsedDocument } from '@openarx/types';

export function buildStructuredContent(parsed: ParsedDocument): Record<string, unknown> {
  const content: Record<string, unknown> = {
    parserUsed: parsed.parserUsed,
    parseDurationMs: parsed.parseDurationMs,
    sectionCount: parsed.sections.length,
    referenceCount: parsed.references.length,
    tableCount: parsed.tables.length,
    formulaCount: parsed.formulas.length,
    sections: parsed.sections,
    references: parsed.references,
    tables: parsed.tables,
    formulas: parsed.formulas,
  };

  // Parser stats — optional, populated by LaTeX parser. Useful for post-hoc
  // coverage diagnostics and the structure_quality signal in parse_quality.
  if (parsed.stats) {
    content.stats = {
      rootTex: parsed.stats.rootTex,
      missingIncludes: parsed.stats.missingIncludes,
      mergedTexChars: parsed.stats.mergedTexChars,
    };
  }

  // Include original non-English sections if document was translated
  const originalSections = (parsed as unknown as Record<string, unknown>).originalSections;
  if (originalSections) {
    content.originalSections = originalSections;
  }

  return content;
}
