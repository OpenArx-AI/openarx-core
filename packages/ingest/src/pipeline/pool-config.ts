/**
 * Resource pool configuration — reads capacity from env vars with sensible defaults.
 *
 * Env format: RESOURCE_POOL_{NAME}={capacity}
 * Example: RESOURCE_POOL_LLM_CHUNKING=3
 */

export interface PoolCapacities {
  llm_chunking: number;
  gemini_embed: number;
  specter2_embed: number;
  qdrant_write: number;
  latex_parse: number;
  grobid_parse: number;
  s2_lookup: number;
}

const DEFAULTS: PoolCapacities = {
  llm_chunking: 3,
  gemini_embed: 5,
  specter2_embed: 6,
  qdrant_write: 10,
  latex_parse: 10,
  grobid_parse: 2,
  s2_lookup: 0,  // Disabled by default — set RESOURCE_POOL_S2_LOOKUP=2 when S2 API key available
};

function envInt(name: string, fallback: number): number {
  const val = process.env[name];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadPoolConfig(): PoolCapacities {
  return {
    llm_chunking: envInt('RESOURCE_POOL_LLM_CHUNKING', DEFAULTS.llm_chunking),
    gemini_embed: envInt('RESOURCE_POOL_GEMINI_EMBED', DEFAULTS.gemini_embed),
    specter2_embed: envInt('RESOURCE_POOL_SPECTER2_EMBED', DEFAULTS.specter2_embed),
    qdrant_write: envInt('RESOURCE_POOL_QDRANT_WRITE', DEFAULTS.qdrant_write),
    latex_parse: envInt('RESOURCE_POOL_LATEX_PARSE', DEFAULTS.latex_parse),
    grobid_parse: envInt('RESOURCE_POOL_GROBID_PARSE', DEFAULTS.grobid_parse),
    s2_lookup: envInt('RESOURCE_POOL_S2_LOOKUP', DEFAULTS.s2_lookup),
  };
}

/** Max concurrent documents in the pool pipeline. */
export function loadMaxConcurrentDocs(): number {
  return envInt('PIPELINE_MAX_CONCURRENT_DOCS', 10);
}
