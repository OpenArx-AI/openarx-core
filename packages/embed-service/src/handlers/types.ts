export type SupportedModel =
  | 'qwen3-embedding-8b'
  | 'gemini-embedding-2-preview';

/** Legacy request-name aliases, resolved at the API boundary (server.ts) before routing.
 *
 *  `specter2` names a MODEL that no longer exists here: the embedding_qwen_migration replaced it
 *  with qwen3-embedding-8b and its inference containers are gone. The name survives in one place
 *  only — the PHYSICAL 768-dim Qdrant named vector is still called "specter2" (it holds qwen; the
 *  schema was deliberately left untouched). A straggler caller asking for the old model name
 *  therefore wants the vector space that qwen now produces, so resolve rather than reject: failing
 *  it would break search for no benefit. The resolved name is what the response reports, so the
 *  substitution is never silent. */
export const MODEL_ALIASES: Readonly<Record<string, SupportedModel>> = {
  specter2: 'qwen3-embedding-8b',
};

/** Resolve a requested model name (real or legacy alias) to the model that serves it. */
export function resolveModel(model: string): SupportedModel | undefined {
  if (model in MODEL_ALIASES) return MODEL_ALIASES[model];
  return model === 'qwen3-embedding-8b' || model === 'gemini-embedding-2-preview'
    ? model
    : undefined;
}

export interface EmbedRequest {
  texts: string[];
  model: SupportedModel;
  taskType?: string;
  outputDimensionality?: number;
  batchSize?: number;
  /** When false, handlers must NOT fall back to secondary providers on
   *  primary failure; they should surface the error to the caller instead.
   *  Default: true (existing behaviour). Used by migration script to
   *  prevent silent spending on OpenRouter when Vertex hits quota. */
  allowFallback?: boolean;
  /** When true, the router skips BOTH cache reads and writes for this
   *  request. Default: false. Used by migration: each chunk text is
   *  unique so cache hit rate is 0%, and writing ~100GB of short-lived
   *  vectors into an 8GB Redis just evicts warm search entries. */
  bypassCache?: boolean;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  provider: string;
  cached: boolean[];
  inputTokens: number;
  cost: number;
}

export interface EmbedHandlerOptions {
  taskType?: string;
  allowFallback?: boolean;
}

export interface ModelHandler {
  readonly model: SupportedModel;
  readonly dimensions: number;
  /** Embed texts that are NOT in the cache. Cache-hit logic is handled by the
   *  router before this is called — handler sees only texts that need embedding. */
  embedUncached(texts: string[], opts?: EmbedHandlerOptions): Promise<{
    vectors: number[][];
    provider: string;
    inputTokens: number;
    cost: number;
  }>;
}
