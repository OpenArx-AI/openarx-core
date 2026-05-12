import Anthropic from '@anthropic-ai/sdk';
import type { ModelOptions, ModelResponse, ModelTask } from '@openarx/types';
import { retry } from './retry.js';

// Default model per task
const TASK_MODELS: Record<ModelTask, string> = {
  chunking: 'claude-sonnet-4-6',
  enrichment: 'claude-sonnet-4-6',
  quality_check: 'claude-opus-4-6',
  search_rerank: 'claude-sonnet-4-6',
  spam_screen: 'claude-haiku-4-5-20251001',
  translation: 'claude-sonnet-4-6',
};

// Approximate cost per 1M tokens (input/output) for common models
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

export interface AnthropicLlmConfig {
  apiKey: string;
}

export class AnthropicLlm {
  private readonly client: Anthropic;

  constructor(config: AnthropicLlmConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async complete(
    task: ModelTask,
    prompt: string,
    options?: ModelOptions,
  ): Promise<ModelResponse> {
    const model = options?.model ?? TASK_MODELS[task];

    const result = await retry(
      () =>
        this.client.messages.create({
          model,
          max_tokens: options?.maxTokens ?? 4096,
          temperature: options?.temperature ?? 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      `anthropic-${task}`,
    );

    const text = result.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const inputTokens = result.usage.input_tokens;
    const outputTokens = result.usage.output_tokens;
    const rates = COST_PER_MILLION[model] ?? { input: 3, output: 15 };
    const cost =
      (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

    return { text, model, provider: 'anthropic', inputTokens, outputTokens, cost };
  }
}
