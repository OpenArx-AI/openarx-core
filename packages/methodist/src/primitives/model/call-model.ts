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
    // Top-level `required` of the declared output_schema, if it declares any. Schemas here are
    // written in Vertex's dialect, but `required` is spelled the same way in both dialects.
    const missingRequiredKeys = (schema: unknown, got: Record<string, unknown>): string[] => {
      if (!schema || typeof schema !== 'object') return [];
      const required = (schema as { required?: unknown }).required;
      if (!Array.isArray(required)) return [];
      return required.filter((k): k is string => typeof k === 'string' && !(k in got));
    };
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
    const raw0 = response.raw.trim();
    try {
      // Robust parse (openarx-tester-8lf): tolerate a ```json … ``` code fence the model may
      // wrap the JSON in. NOTE this does NOT recover a TRUNCATED response — that is fixed by a
      // sufficient output-token budget on the model client (a too-small maxTokens cuts the JSON).
      let raw = raw0;
      const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      if (fence) raw = fence[1].trim();
      result = JSON.parse(raw);
    } catch {
      // Second attempt: extract the OUTERMOST {...} and parse that. The anchored fence regex above
      // only helps when the fence is the whole message; a model that adds a sentence before it, or a
      // trailing note after it, defeats the anchors. Extracting the object survives both.
      // Grader prompts are large and its output style is provider- and setting-dependent (suppressing
      // reasoning on OpenRouter measurably changed whether the JSON came back fenced), so the parse
      // must not depend on the wrapper.
      const first = raw0.indexOf('{');
      const last = raw0.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try {
          result = JSON.parse(raw0.slice(first, last + 1));
        } catch {
          result = undefined;
        }
      }
      if (result === undefined) {
        // ★ Log the raw head/tail before giving up. Without this a bad-output is undiagnosable: the
        // text that failed is discarded, and the operator is left comparing token counts. This cost a
        // live incident (three runs blocked, 3/3 deterministic rejects with nothing to look at).
        console.error(
          JSON.stringify({
            at: 'call-model.bad-output',
            rawLength: raw0.length,
            rawHead: raw0.slice(0, 400),
            rawTail: raw0.length > 400 ? raw0.slice(-200) : '',
          }),
        );
        throw new RuntimeError('bad-output', 'model output is not parseable JSON');
      }
    }
    const outputs = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };

    // Parsing successfully is not the same as getting an answer. A model that returns valid JSON of
    // the WRONG SHAPE used to sail through here: the door then found no verdict, reported
    // {outcome:'ok'} and advanced nothing, so an agent saw success for work that was never graded.
    // That is the more dangerous failure — an explicit reject stops the agent, a false ok does not.
    //
    // So hold the output to the schema the caller declared. Only TOP-LEVEL required keys: `required`
    // is the caller's own explicit statement of what it cannot proceed without, while deeper
    // validation would start rejecting outputs that the pipeline handles fine today.
    const missing = missingRequiredKeys(params.output_schema, outputs);
    if (missing.length > 0) {
      // Log the shape, not the content: enough to diagnose, without spilling submission prose.
      console.error(
        JSON.stringify({
          at: 'call-model.shape-mismatch',
          missing,
          gotKeys: Object.keys(outputs).slice(0, 20),
          rawLength: raw0.length,
        }),
      );
      throw new RuntimeError(
        'bad-output',
        `model output is valid JSON but does not match the declared output_schema (missing: ${missing.join(', ')})`,
      );
    }
    return { outputs };
  },
);
