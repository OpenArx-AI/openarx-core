/**
 * Quality metrics — compute parse quality scores per document.
 *
 * Analyzes chunks for short content, boundary issues, and math density.
 * Stores aggregated metrics on the documents table.
 *
 * parse_quality combines three signals:
 *   - retention: how much of the source text survived chunking (40%)
 *   - chunk quality: how clean the chunks are — sentence boundaries,
 *     minimum length (30%)
 *   - structure quality: parser-level signal from stats in
 *     structured_content — missing includes, merged coverage (30%)
 *
 * The structure signal catches docs where chunking looks fine (retention +
 * chunk quality both pass) but the parser lost body content upstream —
 * e.g. a D7 incomplete upload where half the \input'd files don't exist.
 */

import { query } from '@openarx/api';
import { isBodyInclude } from '../parsers/include-filter.js';

interface ChunkRow {
  content: string;
}

interface ParserStats {
  rootTex?: string | null;
  missingIncludes?: string[];
  mergedTexChars?: number;
}

interface DocumentRow {
  structured_content: {
    parserUsed?: string;
    stats?: ParserStats;
    abstract?: string;
    sections?: Array<{ content?: string }>;
  } | null;
  quality_flags: Record<string, number> | null;
}

interface QualityFlags {
  short_chunks: number;
  boundary_issues: number;
  filtered_chunks: number;
  total_chunks: number;
}

// Unicode math operators U+2200-U+22FF, Greek U+0391-U+03C9, sub/superscripts
const MATH_PATTERN =
  /[\u2200-\u22FF\u0391-\u03C9\u00B2\u00B3\u00B9\u2070-\u209F]|\\(?:frac|sum|int|alpha|beta|gamma|delta|theta|lambda|sigma|omega|infty|partial|nabla|sqrt|prod|lim)\b/;

const SENTENCE_END_PATTERN = /[.!?:;)]\s*$/;

/** Strip trailing LaTeX environment closers and whitespace before boundary check. */
function normalizeEnding(text: string): string {
  return text
    .replace(/(\s*\\end\{[^}]+\}\s*)*$/, '')  // \end{proof}, \end{itemize}, etc.
    .replace(/\s+$/, '');                       // trailing whitespace/newlines
}

export async function computeQualityMetrics(documentId: string): Promise<void> {
  // Fetch all chunks for document
  const { rows: chunks } = await query<ChunkRow>(
    'SELECT content FROM chunks WHERE document_id = $1',
    [documentId],
  );

  // Zero-chunk docs (should be rare after F1 invariant, but possible on
  // manual paths): leave an explicit audit flag instead of silent exit.
  // Prior behaviour left parse_quality NULL with no marker; that masked
  // the problem as indistinguishable from "metrics not yet run".
  if (chunks.length === 0) {
    await query(
      `UPDATE documents
       SET quality_flags = COALESCE(quality_flags, '{}'::jsonb) ||
           jsonb_build_object(
             'quality_metrics_skipped', 'no_chunks',
             'quality_metrics_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
           )
       WHERE id = $1`,
      [documentId],
    );
    return;
  }

  const total = chunks.length;
  let shortChunks = 0;
  let boundaryIssues = 0;
  let mathChunks = 0;

  for (const chunk of chunks) {
    const content = chunk.content;

    if (content.length < 50) shortChunks++;
    if (!SENTENCE_END_PATTERN.test(normalizeEnding(content))) boundaryIssues++;
    if (MATH_PATTERN.test(content)) mathChunks++;
  }

  const mathDensity = mathChunks / total;

  // Get parser used and existing quality_flags from document
  const { rows: docRows } = await query<DocumentRow>(
    'SELECT structured_content, quality_flags FROM documents WHERE id = $1',
    [documentId],
  );

  const sc = docRows[0]?.structured_content ?? null;
  const parserUsed = sc?.parserUsed ?? null;
  const existingFlags = docRows[0]?.quality_flags ?? {};
  const filteredChunks = existingFlags.filtered_chunks ?? 0;

  // Content retention: chunk chars vs section text chars (not full JSON which includes refs/tables/metadata)
  const sections = sc?.sections;
  const sectionChars = Array.isArray(sections)
    ? sections.reduce((sum, s) => sum + (s.content?.length ?? 0), 0)
    : 0;
  // Fallback: if no sections, use abstract length
  const abstractChars = sc?.abstract?.length ?? 0;
  const rawTextChars = sectionChars + abstractChars;
  const chunkChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  const contentRetention = rawTextChars > 0 ? chunkChars / rawTextChars : 1;

  // Chunk quality: proportion of clean chunks (no short, no boundary issues)
  const effectiveTotal = total + filteredChunks;
  const chunkQualityScore = Math.max(0, Math.min(1, 1.0 - (shortChunks + boundaryIssues + filteredChunks) / effectiveTotal));

  // Structure quality: parser-level signal from stats. Catches cases where
  // chunking succeeded on partial content (retention looks OK, chunks are
  // clean) but the parser lost body input upstream.
  //
  // Only applicable when we have parser stats (LaTeX parser emits them;
  // PDF/GROBID doesn't, so we default to neutral 1.0 for those paths).
  const stats = sc?.stats;
  let structureQualityScore = 1.0;
  let missingBodyCount = 0;
  let mergedCoverage: number | null = null;
  if (stats) {
    const missingAll = stats.missingIncludes ?? [];
    const missingBody = missingAll.filter(isBodyInclude);
    missingBodyCount = missingBody.length;

    // Body-miss ratio: penalise per missing body include. Each missing
    // \input is ~one chapter lost. Three in a 20-section paper is 15%
    // content loss; we treat 5+ as severe.
    const missPenalty = Math.min(missingBodyCount * 0.15, 1);

    // Merged-coverage shortfall is only meaningful when it's well below
    // threshold. We compute it against rawTextChars (post-strip) rather
    // than the test harness's effective-source (pre-strip) because that's
    // what we have access to here without re-walking the filesystem.
    // Below 0.3 is suspicious (parser saw <30% of what ended up as sections).
    if (stats.mergedTexChars != null && rawTextChars > 0) {
      mergedCoverage = rawTextChars / stats.mergedTexChars;
    }

    structureQualityScore = Math.max(0, 1 - missPenalty);
  }

  // Combined parse_quality: retention 40% + chunk quality 30% + structure 30%.
  // Old formula was retention 60% + chunk 40% with no structure signal.
  const retentionScore = Math.max(0, Math.min(1, contentRetention));
  const parseQuality = retentionScore * 0.4 + chunkQualityScore * 0.3 + structureQualityScore * 0.3;

  const qualityFlags: Record<string, unknown> = {
    short_chunks: shortChunks,
    boundary_issues: boundaryIssues,
    filtered_chunks: filteredChunks,
    total_chunks: total,
    content_retention: Number(contentRetention.toFixed(4)),
  };
  if (stats) {
    qualityFlags.missing_body_count = missingBodyCount;
    qualityFlags.missing_includes_raw = stats.missingIncludes?.length ?? 0;
    qualityFlags.merged_tex_chars = stats.mergedTexChars ?? 0;
    qualityFlags.root_tex = stats.rootTex ?? null;
    qualityFlags.structure_quality = Number(structureQualityScore.toFixed(4));
    // Observability-only: kept in flags for diagnostic queries but no longer
    // drives needs_reindex (see audit 2026-05-03 in beads epic openarx-151l —
    // 200/200 spot-check showed lc has no signal vs healthy cohort).
    if (mergedCoverage != null) qualityFlags.merged_coverage = Number(mergedCoverage.toFixed(4));
  }

  // Auto-flag for reindex: two triggers, any one is enough.
  //   1. Retention catastrophically low (original trigger).
  //   2. Parser lost 3+ body \input targets.
  //
  // Removed (2026-05-03): low_merged_coverage trigger. Empirical audit on a
  // 43K-doc corpus showed it flagged 86% of healthy docs alongside 98% of
  // production-flagged ones — distributions were statistically identical
  // and 200/200 random spot-checks confirmed zero true negatives lost when
  // dropping it. The metric is structurally low (0.2-0.4) for any normal
  // LaTeX paper because the denominator includes preamble, math envs,
  // figures, and bibliography.
  const retentionTrigger = contentRetention < 0.30 && rawTextChars > 5000;
  const missingBodyTrigger = missingBodyCount >= 3;
  if (retentionTrigger || missingBodyTrigger) {
    qualityFlags.needs_reindex = true;
    const reasons: string[] = [];
    if (retentionTrigger) reasons.push('low_retention_auto');
    if (missingBodyTrigger) reasons.push(`missing_body_${missingBodyCount}`);
    qualityFlags.reindex_reason = reasons.join('+');
    qualityFlags.reindex_severity = contentRetention < 0.05 || missingBodyCount >= 10
      ? 'critical'
      : contentRetention < 0.15 || missingBodyCount >= 5
      ? 'severe'
      : 'moderate';
    qualityFlags.flagged_at = new Date().toISOString();
  }

  await query(
    `UPDATE documents
     SET parse_quality = $1, math_density = $2, parser_used = $3,
         quality_flags = COALESCE(quality_flags, '{}'::jsonb) || $4::jsonb
     WHERE id = $5`,
    [
      parseQuality.toFixed(3),
      mathDensity.toFixed(3),
      parserUsed,
      JSON.stringify(qualityFlags),
      documentId,
    ],
  );
}
