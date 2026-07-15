// ── detect-language v1 (algorithmic · deterministic given the lang-id) ────────
//
// goal: identify a record's language + confidence.
// in: { text } · out: { lang, confidence } · access/effects: none.
// The lang-id model is INJECTED (like the model client) so tests use a deterministic
// stub and integration wires the real detector (an LLM call — english-only ingress,
// MASTER §3.4; see @openarx/api makeLlmLangId). Async because the detector is an LLM call.

import { definePrimitive, type Registration } from '../../runtime/index.js';
import { asRecordArray, recordText } from '../shared.js';

export interface LangId {
  (text: string): Promise<{ lang: string; confidence: number }>;
}

interface In {
  /** single text (unit tests) OR a records array (checkpoint publish → per-record). */
  text?: string;
  records?: unknown;
}
interface Out {
  lang: string;
  confidence: number;
  per_record?: Array<{ lang: string; confidence: number }>;
  /** true iff ≥1 record is CONFIDENTLY a non-English language — the checkpoint gate rejects on
   *  this (english-only ingress, §3.4). 'und' (undetermined / too short) and low confidence PASS —
   *  fail-open by design, never blocks on no-signal or a short fragment. */
  non_english: boolean;
  /** the first offending language code (for the reject reason); absent when non_english is false. */
  non_english_lang?: string;
}

/** A single detection is a fail-closed hit only when it is CONFIDENTLY a language other than English.
 *  Threshold = env LANG_GATE_CONFIDENCE (default 0.7); 'und'/low confidence always PASS (fail-open). */
const NON_EN_CONFIDENCE = Number(process.env.LANG_GATE_CONFIDENCE ?? '0.7');
function isNonEnglish(r: { lang: string; confidence: number }): boolean {
  return r.lang !== 'en' && r.lang !== 'und' && r.confidence >= NON_EN_CONFIDENCE;
}

export function makeDetectLanguage(langId: LangId): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'detect-language',
      version: 'v1',
      kind: 'algorithmic',
      goal: 'identify record language and confidence via an injected lang-id model',
      access: [],
      effects: [],
      determinism: 'deterministic',
    },
    async ({ inputs }) => {
      if (typeof inputs.text === 'string') {
        const r = await langId(inputs.text);
        const non_english = isNonEnglish(r);
        return {
          outputs: {
            lang: r.lang,
            confidence: r.confidence,
            non_english,
            ...(non_english ? { non_english_lang: r.lang } : {}),
          },
        };
      }
      const per_record = await Promise.all(asRecordArray(inputs.records).map((r) => langId(recordText(r))));
      const first = per_record[0] ?? { lang: 'und', confidence: 0 };
      const offending = per_record.find(isNonEnglish);
      return {
        outputs: {
          lang: first.lang,
          confidence: first.confidence,
          per_record,
          non_english: Boolean(offending),
          ...(offending ? { non_english_lang: offending.lang } : {}),
        },
      };
    },
  );
}
