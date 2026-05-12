/**
 * TranslationStep — translates non-English documents to English.
 *
 * Runs after Parse, before Chunk. When document.language !== 'en':
 * 1. Saves original title/abstract to document.originalTitle/originalAbstract
 * 2. Saves original sections to parsedDocument (for structured_content.original_sections)
 * 3. Translates title, abstract, and sections via Gemini Flash
 * 4. Replaces primary fields with English text
 *
 * After this step, all downstream processing (chunk, enrich, embed, index)
 * sees only English text. Zero downstream changes needed.
 */

import type {
  Document,
  ModelOptions,
  ModelResponse,
  ParsedDocument,
  PipelineContext,
  PipelineStep,
} from '@openarx/types';
import { query } from '@openarx/api';

export interface TranslationStepInput {
  document: Document;
  parsedDocument: ParsedDocument;
}

export interface TranslationStepOutput {
  document: Document;
  parsedDocument: ParsedDocument;
  translated: boolean;
}

const TRANSLATE_OPTIONS: ModelOptions = {
  maxTokens: 65536,
  temperature: 0,
};

/** Max chars per translation call to stay within model limits. */
const MAX_SECTION_CHARS = 100_000;

function buildTranslationPrompt(text: string, language: string): string {
  return `Translate the following scientific text from ${language} to English.

Rules:
- Preserve ALL LaTeX commands, formulas, and math notation exactly as-is
- Preserve all citations (\\cite{...}, [1], etc.) exactly as-is
- Preserve section/subsection structure markers
- Do not add, remove, or rephrase content — translate faithfully
- Keep technical terminology accurate
- Return ONLY the translated text, no explanations

Text to translate:

${text}`;
}

async function trackCost(
  costTracker: PipelineContext['costTracker'],
  resp: ModelResponse,
  durationMs: number,
): Promise<void> {
  await costTracker.record(
    'translation',
    resp.model,
    resp.provider ?? 'vertex',
    resp.inputTokens,
    resp.outputTokens,
    resp.cost,
    durationMs,
  );
}

export class TranslationStep implements PipelineStep<TranslationStepInput, TranslationStepOutput> {
  readonly name = 'translation';

  async process(input: TranslationStepInput, context: PipelineContext): Promise<TranslationStepOutput> {
    const { document, parsedDocument } = input;
    const { modelRouter, logger, costTracker } = context;

    const lang = document.language;

    // Skip if English or no language specified
    if (!lang || lang === 'en') {
      return { document, parsedDocument, translated: false };
    }

    logger.info(`Translating document from "${lang}" to English`);

    // 1. Save originals
    document.originalTitle = document.title;
    document.originalAbstract = document.abstract;

    // Save original sections for structured_content.original_sections (stored at indexing)
    const originalSections = parsedDocument.sections.map((s) => ({
      name: s.name,
      content: s.content,
    }));

    // 2. Translate title
    let start = performance.now();
    const titleResponse = await modelRouter.complete(
      'translation',
      buildTranslationPrompt(document.title, lang),
      TRANSLATE_OPTIONS,
    );
    document.title = titleResponse.text.trim();
    await trackCost(costTracker, titleResponse, Math.round(performance.now() - start));
    logger.debug(`Translated title: "${document.originalTitle}" → "${document.title}"`);

    // 3. Translate abstract
    if (document.abstract) {
      start = performance.now();
      const abstractResponse = await modelRouter.complete(
        'translation',
        buildTranslationPrompt(document.abstract, lang),
        TRANSLATE_OPTIONS,
      );
      document.abstract = abstractResponse.text.trim();
      await trackCost(costTracker, abstractResponse, Math.round(performance.now() - start));
    }

    // 4. Translate sections
    let translatedSections = 0;
    for (const section of parsedDocument.sections) {
      if (!section.content || section.content.trim().length === 0) continue;

      if (section.content.length > MAX_SECTION_CHARS) {
        // Split large sections by paragraphs
        const parts = splitByParagraphs(section.content, MAX_SECTION_CHARS);
        const translatedParts: string[] = [];
        for (const part of parts) {
          start = performance.now();
          const resp = await modelRouter.complete(
            'translation',
            buildTranslationPrompt(part, lang),
            TRANSLATE_OPTIONS,
          );
          translatedParts.push(resp.text.trim());
          await trackCost(costTracker, resp, Math.round(performance.now() - start));
        }
        section.content = translatedParts.join('\n\n');
      } else {
        start = performance.now();
        const resp = await modelRouter.complete(
          'translation',
          buildTranslationPrompt(section.content, lang),
          TRANSLATE_OPTIONS,
        );
        section.content = resp.text.trim();
        await trackCost(costTracker, resp, Math.round(performance.now() - start));
      }
      translatedSections++;
    }

    // 5. Translate section names (batch)
    const namedSections = parsedDocument.sections.filter((s) => s.name && s.name.trim().length > 0);
    if (namedSections.length > 0) {
      const namesText = namedSections.map((s) => s.name).join('\n');
      start = performance.now();
      const resp = await modelRouter.complete(
        'translation',
        `Translate these scientific paper section titles from ${lang} to English. Return one title per line, same order:\n\n${namesText}`,
        TRANSLATE_OPTIONS,
      );
      const translatedNames = resp.text.trim().split('\n').map((t) => t.trim());
      await trackCost(costTracker, resp, Math.round(performance.now() - start));

      for (let i = 0; i < namedSections.length && i < translatedNames.length; i++) {
        namedSections[i].name = translatedNames[i];
      }
    }

    // 6. Persist translated title/abstract + originals to DB
    await query(
      'UPDATE documents SET title = $1, abstract = $2, original_title = $3, original_abstract = $4 WHERE id = $5',
      [document.title, document.abstract, document.originalTitle, document.originalAbstract, document.id],
    );

    // Store original_sections on parsedDocument for indexer to save in structured_content
    (parsedDocument as unknown as Record<string, unknown>).originalSections = originalSections;

    logger.info(`Translation complete: ${translatedSections} sections translated from "${lang}"`);

    return { document, parsedDocument, translated: true };
  }
}

/** Split text into parts at paragraph boundaries, each <= maxChars. */
function splitByParagraphs(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const parts: string[] = [];
  let current = '';

  for (const p of paragraphs) {
    if (current.length + p.length + 2 > maxChars && current.length > 0) {
      parts.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) parts.push(current);

  return parts;
}
