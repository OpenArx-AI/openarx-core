// ── Model client (runtime §2, §5 vbok) ───────────────────────────────────────
//
// INJECTED into model-call primitives by the runtime — never imported by them —
// so tests can substitute a recorded/mock response. In production this is the
// existing Vertex / GOOGLE_AI_API_KEY path with native context-caching; NO new
// key. Model-call primitives do pure generation (no agentic tool-loop).

export interface ModelRequest {
  /** the prepared prompt/context (output of prepare-context) */
  readonly context: string;
  readonly modelId: string;
  /** structured-output schema the response must parse into */
  readonly outputSchema?: unknown;
  readonly modeParams?: Record<string, unknown>;
  /** cache anchor over the stable part (methodology / content-pack) */
  readonly cacheAnchor?: string;
}

export interface ModelResponse {
  /** raw model text; the primitive parses it into its output_schema */
  readonly raw: string;
}

export interface ModelClient {
  generate(req: ModelRequest): Promise<ModelResponse>;
}
