export type SupportedModel =
  | 'specter2'
  | 'gemini-embedding-2-preview';

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
