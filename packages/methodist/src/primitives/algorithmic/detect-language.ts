// ── detect-language v1 (algorithmic · deterministic given the lang-id) ────────
//
// goal: identify a record's language + confidence.
// in: { text } · out: { lang, confidence } · access/effects: none.
// The lang-id model (fastText/CLD3) is INJECTED (like the model client) so tests
// use a deterministic stub and integration wires the real local detector.

import { definePrimitive, type Registration } from '../../runtime/index.js';
import { asRecordArray, recordText } from '../shared.js';

export interface LangId {
  (text: string): { lang: string; confidence: number };
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
    ({ inputs }) => {
      if (typeof inputs.text === 'string') {
        const { lang, confidence } = langId(inputs.text);
        return { outputs: { lang, confidence } };
      }
      const per_record = asRecordArray(inputs.records).map((r) => langId(recordText(r)));
      const first = per_record[0] ?? { lang: 'und', confidence: 0 };
      return { outputs: { lang: first.lang, confidence: first.confidence, per_record } };
    },
  );
}
