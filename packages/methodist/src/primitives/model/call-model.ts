// ── call-model v1 (model-call · model-dependent) ─────────────────────────────
//
// goal: call the model on the prepared context and parse the structured output.
// Wave-v2 form (converged): the methodology passes the MODEL + OUTPUT_SCHEMA as
// `params` and the prepared context as `in.context` (the prepare-context output
// slot, {prepared_context, cache_anchor}, or a bare string).
// in: { context, cache_anchor? }, params: { model, output_schema?, mode_params? }
// out: { result } · access/effects: none (injected model client, §2).
// Technical fault retried by the runtime; unparseable output → bad-output (rejected).

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

interface PreparedContext {
  prepared_context?: string;
  cache_anchor?: string;
}
interface In {
  context: string | PreparedContext;
  cache_anchor?: string;
}
interface Params {
  model: string;
  output_schema?: unknown;
  mode_params?: Record<string, unknown>;
}
// The parsed model output becomes the slot value directly, so the methodology can
// reference its fields ($verdict.verdict, $diag.dose). A non-object result wraps as
// { result }.
type Out = Record<string, unknown>;

export const callModelPrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'call-model',
    version: 'v1',
    kind: 'model-call',
    goal: 'call the model on a prepared context and parse the structured output',
    access: [],
    effects: [],
    determinism: 'model-dependent',
  },
  async ({ inputs, params, model }) => {
    const ctx = inputs.context;
    const prepared = typeof ctx === 'string' ? ctx : (ctx?.prepared_context ?? '');
    const cacheAnchor = (typeof ctx === 'object' ? ctx?.cache_anchor : undefined) ?? inputs.cache_anchor;

    const response = await model!.generate({
      context: prepared,
      modelId: params.model,
      outputSchema: params.output_schema,
      modeParams: params.mode_params,
      cacheAnchor,
    });
    let result: unknown;
    try {
      // Robust parse (openarx-tester-8lf): tolerate a ```json … ``` code fence the model may
      // wrap the JSON in. NOTE this does NOT recover a TRUNCATED response — that is fixed by a
      // sufficient output-token budget on the model client (a too-small maxTokens cuts the JSON).
      let raw = response.raw.trim();
      const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (fence) raw = fence[1].trim();
      result = JSON.parse(raw);
    } catch {
      throw new RuntimeError('bad-output', 'model output is not parseable JSON');
    }
    const outputs = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
    return { outputs };
  },
);
