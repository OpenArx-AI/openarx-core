/**
 * LLM-based code link extraction (Tier 3 fallback).
 *
 * Only called when PwC + regex found 0 code links.
 * Scans implementation/code/availability sections for GitHub URLs.
 */

import type { Chunk, PipelineContext } from '@openarx/types';

const CODE_SECTION_RE =
  /\b(implementation|code|github|repository|availability|software|open.?source|released)\b/i;

const GITHUB_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/;

export async function extractCodeLinksWithLlm(
  chunks: Chunk[],
  context: PipelineContext,
): Promise<string[]> {
  const { modelRouter, logger, costTracker } = context;

  // Find chunks from code-related sections
  let relevantChunks = chunks.filter((c) =>
    CODE_SECTION_RE.test(c.context.sectionName ?? '') ||
    CODE_SECTION_RE.test(c.content.slice(0, 200)),
  );

  // Fallback: Introduction + Conclusion chunks
  if (relevantChunks.length === 0) {
    relevantChunks = chunks.filter((c) => {
      const section = (c.context.sectionName ?? '').toLowerCase();
      return section.includes('introduction') || section.includes('conclusion');
    });
  }

  // Last resort: first and last 3 chunks
  if (relevantChunks.length === 0) {
    relevantChunks = [...chunks.slice(0, 3), ...chunks.slice(-3)];
  }

  const text = relevantChunks.map((c) => c.content).join('\n\n').slice(0, 4000);

  const prompt = `Extract code repository URLs from this scientific paper text. Look for GitHub URLs, references to open-source implementations, or mentions of code availability.

Return a JSON array of GitHub repository URLs. If no code repositories are found, return [].

Text:
${text}

Return ONLY the JSON array, no other text.`;

  const start = performance.now();
  const response = await modelRouter.complete('enrichment', prompt);
  const durationMs = Math.round(performance.now() - start);

  await costTracker.record(
    'enrichment-code',
    response.model,
    response.provider ?? 'openrouter',
    response.inputTokens,
    response.outputTokens,
    response.cost,
    durationMs,
  );

  // Parse response
  let cleaned = response.text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let urls: string[];
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    urls = parsed.filter((u): u is string => typeof u === 'string');
  } catch {
    logger.debug('LLM code extraction: failed to parse response');
    return [];
  }

  // Filter to valid GitHub repo URLs only
  return urls.filter((u) => GITHUB_URL_RE.test(u));
}
