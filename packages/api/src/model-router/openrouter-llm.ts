import type { ModelOptions, ModelResponse, ModelTask } from '@openarx/types';
import { retry } from './retry.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

// Cost per 1M tokens (input/output) for OpenRouter models
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
};

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
    const model = options?.model ?? DEFAULT_MODEL;

    const result = await retry(
      () => this.callApi(model, prompt, options),
      `openrouter-${task}`,
    );

    const choice = result.choices[0];
    const text = choice?.message?.content ?? '';
    const inputTokens = result.usage?.prompt_tokens ?? 0;
    const outputTokens = result.usage?.completion_tokens ?? 0;
    const rates = COST_PER_MILLION[model] ?? { input: 0.5, output: 3 };
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

  private async callApi(
    model: string,
    prompt: string,
    options?: ModelOptions,
  ): Promise<OpenRouterChatResponse> {
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
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `OpenRouter chat failed (${resp.status}): ${body}`,
      );
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
