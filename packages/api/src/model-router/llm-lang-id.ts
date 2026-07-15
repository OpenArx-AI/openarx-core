// ── llm-lang-id — LLM-backed language detector (english-only ingress, MASTER §3.4) ───────────
//
// Detects the ACTUAL primary language of text so ANY non-English is caught — including
// Latin-script languages (es/fr/de/pt) that a charset/script heuristic cannot tell apart from
// English. This is deliberately an LLM, not a bundled fastText/CLD3 model: no new dependency
// (zero-third-party), and Vertex flash is already deployed. Model = gemini-2.5-flash-lite
// (Vlad directive: the cheapest flash tier, ample for language ID; NOT pro).
//
// LLM-agnostic by design: it takes an INJECTED text→text completion, so the methodist door
// engine (VertexLlm) and the ingest pipeline (ModelRouter) share one detector. It judges a
// SAMPLE (first ~800 chars) — language ID needs no full document (keeps bulk-ingest cost low).

export interface LangResult {
  /** ISO 639-1 code of the primary language ('en', 'ru', …); 'und' when undetermined. */
  lang: string;
  /** model confidence in [0,1]; 0 when undetermined or unparseable (callers treat as no-signal). */
  confidence: number;
}

/** Injected LLM call: prompt → raw text (expected to be the JSON the schema requests). */
export type CompleteText = (
  prompt: string,
  opts: { model: string; responseMimeType?: string; responseSchema?: unknown; maxTokens?: number },
) => Promise<string>;

export const DEFAULT_LANG_DETECT_MODEL = 'gemini-2.5-flash-lite';
const SAMPLE_CHARS = 800;
const LANG_SCHEMA = {
  type: 'object',
  properties: { lang: { type: 'string' }, confidence: { type: 'number' } },
  required: ['lang', 'confidence'],
};

/** Build a language detector over an injected LLM completion. Returns { 'und', 0 } for text too
 *  short to judge or when the model output can't be parsed — a fail-OPEN default (no-signal), so a
 *  detector outage never blocks the pipeline; the callers' gate only rejects on a CONFIDENT non-en. */
export function makeLlmLangId(
  complete: CompleteText,
  model: string = DEFAULT_LANG_DETECT_MODEL,
): (text: string) => Promise<LangResult> {
  return async (text: string): Promise<LangResult> => {
    const sample = (text ?? '').trim().slice(0, SAMPLE_CHARS);
    if (sample.length < 3) return { lang: 'und', confidence: 0 };
    const prompt =
      'Identify the PRIMARY natural language of the TEXT below. Respond ONLY with JSON ' +
      '{"lang":"<ISO 639-1 code>","confidence":<0..1>}. Set "lang" to "en" only if the text is ' +
      'primarily English; otherwise use the actual language code. Occasional foreign terms, ' +
      'citations, code, math, symbols or proper nouns do NOT change the primary language.\n\nTEXT:\n' +
      sample;
    let raw: string;
    try {
      raw = await complete(prompt, {
        model,
        responseMimeType: 'application/json',
        responseSchema: LANG_SCHEMA,
        maxTokens: 32,
      });
    } catch (e) {
      // fail-OPEN (never blocks the pipeline) but NEVER silently — a detector outage that
      // swallowed its own error would make the whole language gate a no-op invisibly.
      console.error(
        JSON.stringify({ at: 'llm-lang-id.error', model, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }),
      );
      return { lang: 'und', confidence: 0 };
    }
    try {
      const o = JSON.parse(raw) as { lang?: unknown; confidence?: unknown };
      const lang = typeof o.lang === 'string' && o.lang.trim() ? o.lang.trim().toLowerCase() : 'und';
      const confidence =
        typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0;
      return { lang, confidence };
    } catch {
      return { lang: 'und', confidence: 0 };
    }
  };
}
