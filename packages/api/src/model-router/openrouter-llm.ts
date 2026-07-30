import type { ModelOptions, ModelResponse, ModelTask } from '@openarx/types';
import { retry } from './retry.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

// Cost per 1M tokens (input/output). Verified against OpenRouter's live /models pricing 2026-07-26.
//
// EVERY model the pipeline actually calls must be listed. The table previously held only flash, so
// a chunker retry on the pro model was costed at FLASH rates — under-reporting it 4x (pro is
// 2.0/12.0 against flash's 0.5/3.0) and making per-document cost look cheaper than it is. An
// accounting gap like that is worse than a missing number: it reports success while the instrument
// is wrong.
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
  'google/gemini-3.1-pro-preview': { input: 2, output: 12 }, // chunker retry fallback
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 }, // language detection
};
/** Rate used when a model is absent from the table above. Deliberately the DEAREST known rate, not
 *  the cheapest: an unknown model then over-states cost, which is noticed, instead of under-stating
 *  it, which is not. Add the model to the table rather than relying on this. */
const UNKNOWN_MODEL_RATE = { input: 2, output: 12 };

export interface OpenRouterLlmConfig {
  apiKey: string;
}

interface OpenRouterChatResponse {
  choices: Array<{
    message: { content: string };
    // OpenAI-compatible: 'stop' | 'length' | 'content_filter' | 'tool_calls'
    finish_reason?: string;
    // Some providers also include native provider reason (e.g. Gemini's 'MAX_TOKENS')
    native_finish_reason?: string;
  }>;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/** Google model ids differ by provider: Vertex names the model `gemini-3-flash-preview`, OpenRouter
 *  names the same model `google/gemini-3-flash-preview`. Call sites across the pipeline (chunker
 *  fallback, spam-screen, language detection, the methodist doors) hardcode the Vertex spelling
 *  because Vertex was the LLM provider, so moving to OpenRouter would make every one of those calls
 *  fail with an unknown-model error.
 *
 *  Normalising here, inside the provider adapter, keeps provider-specific spelling out of the
 *  callers entirely: a caller asks for "gemini-3.1-pro-preview" and each adapter renders it the way
 *  its own API expects. Fixing the call sites instead would mean editing every one of them, and
 *  missing one would break that path silently at switch-over.
 *
 *  Only bare `gemini-*` ids are rewritten; anything already namespaced (`google/…`, `qwen/…`,
 *  `anthropic/…`) is passed through untouched. Verified against the live OpenRouter catalogue
 *  2026-07-26: google/gemini-3-flash-preview, google/gemini-3.1-pro-preview and
 *  google/gemini-2.5-flash-lite all exist. */
export function toOpenRouterModelId(model: string): string {
  return /^gemini[-.]/.test(model) ? `google/${model}` : model;
}

export class OpenRouterLlm {
  private readonly apiKey: string;

  constructor(config: OpenRouterLlmConfig) {
    this.apiKey = config.apiKey;
  }

  async complete(
    task: ModelTask,
    prompt: string,
    options?: ModelOptions,
  ): Promise<ModelResponse> {
    const model = toOpenRouterModelId(options?.model ?? DEFAULT_MODEL);

    const result = await retry(
      () => this.callWithRateLimitBackoff(model, prompt, options),
      `openrouter-${task}`,
    );

    const choice = result.choices[0];
    const text = choice?.message?.content ?? '';
    const inputTokens = result.usage?.prompt_tokens ?? 0;
    const outputTokens = result.usage?.completion_tokens ?? 0;
    const rates = COST_PER_MILLION[model] ?? UNKNOWN_MODEL_RATE;
    const cost =
      (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

    // Normalize finish_reason to the code's expected vocabulary (Vertex-style):
    //   OpenAI/OpenRouter 'length' → 'MAX_TOKENS'
    //   'content_filter' → 'SAFETY'
    //   'stop' / undefined → 'STOP'
    // chunker-step.ts:147 branches on 'MAX_TOKENS' to trigger fallback model;
    // without this mapping OpenRouter truncations passed through silently and
    // we parsed incomplete JSON (the "batch monotonicity" bug).
    const raw = choice?.native_finish_reason ?? choice?.finish_reason ?? 'stop';
    const finishReason = mapFinishReason(raw);

    // Log when the provider says anything other than a clean stop — these
    // are the cases we want diagnosable without chunker-side error heuristics.
    if (finishReason !== 'STOP') {
      const contentLen = text.length;
      const contentTail = text.slice(-120).replace(/\s+/g, ' ');
      console.warn(
        `[openrouter:${task}] non-stop finish_reason=${raw} → ${finishReason} ` +
        `model=${model} in=${inputTokens} out=${outputTokens} contentLen=${contentLen} ` +
        `tail="${contentTail}"`,
      );
    }

    return { text, model, provider: 'openrouter', inputTokens, outputTokens, cost, finishReason };
  }

  /** Wait out a 429 in place, instead of letting the generic retry treat it like any failure.
   *
   *  OpenRouter throttles per MODEL under load ("High demand for google/gemini-3-flash-preview"),
   *  which is a rate limit measured over a minute-scale window. The generic retry backs off 1s then
   *  2s — shorter than the window — and every concurrent worker retries in lockstep, so a burst
   *  guarantees its own failure: the 2026-07-26 100-document run produced 63 × 429 and tripped the
   *  fail-rate guard at 85 documents. Waits are long, escalating and JITTERED so the pool
   *  de-synchronises rather than re-colliding, and the provider's Retry-After wins when present. */
  private static readonly RATE_LIMIT_WAITS_MS = [15_000, 45_000, 120_000];

  private async callWithRateLimitBackoff(
    model: string,
    prompt: string,
    options?: ModelOptions,
  ): Promise<OpenRouterChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callApi(model, prompt, options);
      } catch (err) {
        const e = err as { status?: number; retryAfterMs?: number };
        if (e.status !== 429 || attempt >= OpenRouterLlm.RATE_LIMIT_WAITS_MS.length) throw err;
        const base = e.retryAfterMs ?? OpenRouterLlm.RATE_LIMIT_WAITS_MS[attempt];
        const waitMs = Math.round(base * (0.75 + Math.random() * 0.5)); // ±25% jitter
        console.warn(
          `[openrouter] 429 rate-limited on ${model}; waiting ${Math.round(waitMs / 1000)}s ` +
            `(attempt ${attempt + 1}/${OpenRouterLlm.RATE_LIMIT_WAITS_MS.length})`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  private async callApi(
    model: string,
    prompt: string,
    options?: ModelOptions,
  ): Promise<OpenRouterChatResponse> {
    // Callers that need machine-readable output say so via responseMimeType, and on Vertex that
    // CONSTRAINED decoding — the model could not emit anything but JSON. This adapter used to ignore
    // the field, so switching the methodist off Vertex silently dropped that guarantee: the grader
    // began answering in markdown prose ("**VERDICT: GO** …") and every checkpoint failed to parse.
    //
    // OpenRouter's equivalent is response_format. json_object alone buys only syntax — the model is
    // then free to return valid JSON of the WRONG SHAPE, which is what happened next: the grader
    // answered in JSON that carried no verdict, so checkpoints parsed cleanly and still advanced
    // nothing. Vertex enforced BOTH halves, so both have to be restored.
    //
    // The schemas are written in Vertex's dialect (uppercase types), so they are translated below.
    // Translation is best-effort by design and the request never depends on it: anything it cannot
    // express degrades to json_object rather than risking a 400 on a call that must not fail.
    const wantsJson = options?.responseMimeType === 'application/json';
    const jsonSchema = wantsJson ? toJsonSchema(options?.responseSchema) : undefined;
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: options?.maxTokens ?? 65536,
        temperature: options?.temperature ?? 0,
        // Suppress reasoning. Chunking and enrichment are extraction tasks — thinking tokens buy
        // nothing here, consume the output budget (they can starve the answer into a MAX_TOKENS
        // truncation) and are billed like any other output token.
        //
        // Measured on google/gemini-3.1-pro-preview with a realistic chunking prompt:
        //   default          1996 completion of which 1830 reasoning — 92% waste, 184 tokens of answer
        //   effort:'minimal' 1254 completion of which  947 reasoning — and the answer nearly doubles
        //   exclude:true     1972 completion of which 1916 reasoning — it only HIDES the reasoning
        //                    from the response while still generating and billing it. A trap.
        // `enabled:false` and `max_tokens:0` are rejected outright by that model.
        //
        // So 'minimal' is the only lever that reduces it — the same conclusion Vertex reached, where
        // thinkingBudget:0 was silently ignored and only thinkingLevel:'minimal' worked. It reduces
        // rather than eliminates: on flash (which serves ~all chunking) reasoning already measures 0,
        // so this mainly protects the 4x-priced pro retry path.
        //
        // NOT on the JSON path. Measured on the methodist's verdict call: with effort:'minimal' the
        // model stops honouring "return JSON" and writes the verdict as prose (correct content,
        // unreadable shape) — and it does so NON-deterministically, so it reads as a flaky pipeline
        // rather than a format bug. Suppression is a cost lever for the free-form extraction tasks
        // (chunking is ~all of the spend and passes no mime type); it is not worth a lost guarantee
        // on a call that decides whether a research stage may proceed.
        ...(wantsJson ? {} : { reasoning: { effort: 'minimal' as const } }),
        ...(wantsJson
          ? {
              response_format: jsonSchema
                ? // strict:false — the goal is to steer the shape, not to have the provider reject
                  // schemas it reads more pedantically than Vertex did. The caller validates the
                  // required keys itself and fails loudly if they are missing.
                  { type: 'json_schema' as const, json_schema: { name: 'response', strict: false, schema: jsonSchema } }
                : { type: 'json_object' as const },
            }
          : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      const error = new Error(`OpenRouter chat failed (${resp.status}): ${body}`) as Error & {
        status?: number;
        retryAfterMs?: number;
      };
      // Carry the status so the rate-limit path can recognise a 429 without parsing the message,
      // and honour Retry-After when the provider tells us how long to wait.
      error.status = resp.status;
      const retryAfter = resp.headers.get('retry-after');
      if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs > 0) error.retryAfterMs = secs * 1000;
      }
      throw error;
    }

    return (await resp.json()) as OpenRouterChatResponse;
  }
}

/** Map provider finish_reason strings to the internal vocabulary used by
 *  ChunkerStep and VertexLlm. Unknown values pass through uppercased so
 *  consumers can decide. Normalises:
 *    stop / end_turn       → STOP
 *    length / MAX_TOKENS   → MAX_TOKENS
 *    content_filter / SAFETY → SAFETY
 */
function mapFinishReason(raw: string): string {
  const v = raw.toLowerCase();
  if (v === 'stop' || v === 'end_turn' || v === '') return 'STOP';
  if (v === 'length' || v === 'max_tokens') return 'MAX_TOKENS';
  if (v === 'content_filter' || v === 'safety') return 'SAFETY';
  return raw.toUpperCase();
}

// Vertex writes JSON Schema in its own dialect — types are uppercase enum names (STRING, OBJECT)
// and it carries a few keys standard JSON Schema has no place for. OpenRouter expects the standard
// spelling, so translate rather than drop the schema: the shape constraint is the half of the
// guarantee that decides whether a grader's answer is usable.
//
// Returns undefined for anything it cannot faithfully express, and the caller then falls back to a
// plain json_object request. A wrong translation would be worse than none — it could make the
// provider reject a call that must not fail — so this only maps what it is sure of.
const VERTEX_TYPES: Record<string, string> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
};

export function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const src = schema as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    switch (key) {
      case 'type': {
        if (typeof value !== 'string') return undefined;
        // Already-standard lowercase passes through, so a schema in either dialect works.
        const mapped = VERTEX_TYPES[value] ?? (Object.values(VERTEX_TYPES).includes(value) ? value : undefined);
        if (!mapped) return undefined;
        out.type = mapped;
        break;
      }
      case 'properties': {
        if (!value || typeof value !== 'object') return undefined;
        const props: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          const converted = toJsonSchema(sub);
          if (!converted) return undefined; // one unconvertible field invalidates the whole schema
          props[name] = converted;
        }
        out.properties = props;
        break;
      }
      case 'items': {
        const converted = toJsonSchema(value);
        if (!converted) return undefined;
        out.items = converted;
        break;
      }
      case 'nullable': {
        // Vertex's `nullable` has no standard equivalent that is safe to synthesise here; dropping
        // it only loosens the constraint, which is the harmless direction.
        break;
      }
      case 'propertyOrdering': {
        break; // Vertex-only presentation hint, meaningless to OpenRouter.
      }
      case 'required':
      case 'enum':
      case 'description':
      case 'format':
      case 'minItems':
      case 'maxItems': {
        out[key] = value;
        break;
      }
      default:
        return undefined; // an unrecognised key means this translator does not understand the schema
    }
  }
  return out.type ? out : undefined;
}
