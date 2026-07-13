// ── prepare-context v1 (transform · deterministic) ───────────────────────────
//
// goal: assemble the model context from a door prompt-body + named runtime inputs.
// Wave-v2 form (converged with methodist 2026-07-08): a door prompt body is a
// STATIC instruction prefix (cached) followed by a trailing `--- RUNTIME INPUTS ---`
// block carrying `{{name}}` tokens. prepare-context substitutes each `{{name}}`
// from in[name] (a string as-is, an object via JCS — byte-stable) and sets the
// cache_anchor over the STATIC prefix so the whole instruction prefix is a stable
// context-cache prefix.
// params: { prompt: <body> } · in: { <named sources> } · out: { prepared_context, cache_anchor }
// access/effects: none.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { definePrimitive, type Registration } from '../../runtime/index.js';

const require = createRequire(import.meta.url);
const canonicalize = require('canonicalize') as (input: unknown) => string | undefined;

const RUNTIME_MARKER = '--- RUNTIME INPUTS ---';

interface Params {
  prompt: string;
}
type In = Record<string, unknown>;
interface Out {
  prepared_context: string;
  cache_anchor: string;
}

export const prepareContextPrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'prepare-context',
    version: 'v1',
    kind: 'transform',
    goal: 'assemble the model context from a prompt body + named inputs, with a cache anchor',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => {
    const body = typeof params.prompt === 'string' ? params.prompt : '';
    const prepared = body.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
      if (name in inputs) {
        const v = inputs[name];
        return typeof v === 'string' ? v : (canonicalize(v) ?? 'null');
      }
      return whole; // unresolved token left intact
    });
    // cache anchor over the STATIC prefix (before the runtime-inputs marker; else
    // the part before the first token) — the stable, cacheable instruction prefix.
    const markerIdx = body.indexOf(RUNTIME_MARKER);
    const staticPrefix = markerIdx >= 0 ? body.slice(0, markerIdx) : body.split('{{')[0];
    const cache_anchor = createHash('sha256').update(staticPrefix, 'utf8').digest('hex');
    return { outputs: { prepared_context: prepared, cache_anchor } };
  },
);
