/**
 * ParserStep — PDF → ParsedDocument.
 *
 * GROBID-only (Docling fallback removed — Docling produced lower-quality output
 * and GROBID handles 99%+ of papers reliably with retry+timeout).
 * GROBID has built-in retry (3 attempts, exponential backoff) and 240s timeout
 * per attempt — sufficient for PDFs up to ~30MB.
 * 1s delay between docs to prevent GROBID overload.
 */

import type { Document, ParsedDocument, PipelineContext, PipelineStep } from '@openarx/types';
import { parseWithGrobid } from '../parsers/grobid-client.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ParserStepInput {
  pdfPath: string;
  document: Document;
}

export class ParserStep implements PipelineStep<ParserStepInput, ParsedDocument> {
  readonly name = 'parser';

  async process(input: ParserStepInput, context: PipelineContext): Promise<ParsedDocument> {
    const { pdfPath, document } = input;
    const { logger, costTracker } = context;

    try {
      logger.info('Parsing with GROBID');
      const start = performance.now();
      const parsed = await parseWithGrobid(pdfPath);
      const durationMs = Math.round(performance.now() - start);

      logger.info(`GROBID parse complete: ${parsed.sections.length} sections in ${durationMs}ms`);

      await costTracker.record('parsing', 'grobid', 'self-hosted', 0, 0, 0, durationMs);

      // Delay to prevent GROBID overload
      await sleep(1000);

      return parsed;
    } catch (grobidErr) {
      const msg = grobidErr instanceof Error ? grobidErr.message : String(grobidErr);
      logger.error(`GROBID parse failed after retries for ${document.sourceId}: ${msg}`);
      throw new Error(`GROBID parse failed for document ${document.sourceId}: ${msg}`);
    }
  }
}
