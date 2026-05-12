import type {
  EmbedResponse,
  ModelOptions,
  ModelResponse,
  ModelRouter,
  ModelTask,
} from '@openarx/types';

import { AnthropicLlm } from './anthropic-llm.js';
import { OpenRouterLlm } from './openrouter-llm.js';
import { VertexLlm } from './vertex-llm.js';

export interface ModelRouterConfig {
  anthropicApiKey: string;
  openrouterApiKey: string;
  googleAiApiKey?: string;   // GOOGLE_AI_API_KEY — enables Vertex/Google AI direct
}

/**
 * Drop-in shape for callers that want a model-bound embedder. Built by
 * EmbedClient.forModel() so consumers can hold a "model-fixed" reference
 * without baking the model name into the call sites.
 */
export interface EmbedderImpl {
  embed(texts: string[]): Promise<EmbedResponse>;
}

/**
 * LLM provider selection:
 *   GOOGLE_AI_API_KEY set → use Google AI direct (no OpenRouter markup)
 *   Otherwise → use OpenRouter
 *
 * Embeddings are routed through openarx-embed-service (see EmbedClient);
 * this class no longer owns an embedder — it only wires LLM provider for
 * .complete() calls used by enrichers, spam-screen, and aspect 3 worker.
 */
export class DefaultModelRouter implements ModelRouter {
  private readonly llm: { complete(task: ModelTask, prompt: string, options?: ModelOptions): Promise<ModelResponse> };
  private readonly providerName: string;

  constructor(config: ModelRouterConfig) {
    const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;
    if (saKeyFile || config.googleAiApiKey) {
      // Direct Vertex AI for LLM — no OpenRouter markup
      // Priority: Service Account > API Key
      this.llm = new VertexLlm({
        apiKey: config.googleAiApiKey,
        serviceAccountKeyFile: saKeyFile,
      });
      this.providerName = 'vertex';
    } else {
      // OpenRouter (existing default)
      this.llm = new OpenRouterLlm({ apiKey: config.openrouterApiKey });
      this.providerName = 'openrouter';
    }
    console.error(`[model-router] LLM provider: ${this.providerName}`);
  }

  async complete(
    task: ModelTask,
    prompt: string,
    options?: ModelOptions,
  ): Promise<ModelResponse> {
    return this.llm.complete(task, prompt, options);
  }
}

export { AnthropicLlm } from './anthropic-llm.js';
export { OpenRouterLlm } from './openrouter-llm.js';
export { VertexLlm } from './vertex-llm.js';
export { Specter2Client } from './specter2-client.js';
export { RerankerClient } from './reranker-client.js';
export type { RerankResult, RerankResponse } from './reranker-client.js';
export { EmbeddingPool } from './embedding-pool.js';
export { EmbedClient, type EmbedClientConfig, type EmbedClientRequestOverrides, type EmbedModel } from './embed-client.js';
