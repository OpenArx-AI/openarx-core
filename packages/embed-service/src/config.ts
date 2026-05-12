export interface Config {
  socketPath: string;
  tcpHost: string;
  tcpPort: number;
  internalSecret: string;
  redisCacheUrl: string;
  cacheTtlSeconds: number;
  specter2Url: string;
  /** Multi-server pool for SPECTER2. Empty array → single-server mode
   *  (fallback to specter2Url). Populated from EMBEDDING_SERVERS env as
   *  comma-separated list, same format used historically by Specter2Client
   *  in @openarx/api. Pool provides round-robin + per-server capacity +
   *  health-based failover across the 5 deployed SPECTER2 instances
   *  (S1/S2/S3 + 2 external hosts). */
  specter2ServerUrls: string[];
  openrouterApiKey: string;
  vertexSaKeyFile: string | undefined;
  googleCloudProject: string | undefined;
  googleCloudLocation: string;
  gemini2ConcurrencyLimit: number;
  gemini2VertexRatePerMinute: number;
  disableCache: boolean;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): Config {
  return {
    socketPath: process.env.EMBED_SERVICE_SOCKET ?? '/run/openarx/embed.sock',
    tcpHost: process.env.EMBED_SERVICE_HOST ?? '127.0.0.1',
    tcpPort: Number(process.env.EMBED_SERVICE_PORT ?? 3400),
    internalSecret: req('CORE_INTERNAL_SECRET'),
    // When EMBED_CACHE_DISABLED=1, no Redis connection is opened so the
    // URL becomes optional. Used for multi-server experiments where the
    // secondary instance has no Redis available.
    redisCacheUrl: process.env.EMBED_CACHE_DISABLED === '1'
      ? (process.env.REDIS_CACHE_URL ?? '')
      : req('REDIS_CACHE_URL'),
    cacheTtlSeconds: Number(process.env.EMBED_CACHE_TTL_SECONDS ?? 60 * 60 * 24 * 90),
    specter2Url: process.env.SPECTER2_URL ?? 'http://localhost:8090',
    specter2ServerUrls: (process.env.EMBEDDING_SERVERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
    // Embed-service has its own env var name to avoid co-opting other
    // processes (runner / mcp / enrichment) that read the shared GOOGLE_SA_KEY_FILE
    // from .env — those paths should stay on API Key mode for their respective
    // LLM / embedder calls. Only the embed-service should route through SA.
    vertexSaKeyFile: process.env.GOOGLE_SA_KEY_FILE_EMBEDDING,
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
    googleCloudLocation: process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
    gemini2ConcurrencyLimit: Number(process.env.GEMINI2_CONCURRENCY ?? 16),
    // Cap on outbound Vertex :embedContent RPM. 0 = unlimited (pre-rate-limit
    // behaviour, useful for measuring). Default 3800 stays under the us-central1
    // quota of 4000 with headroom for runner + skew.
    gemini2VertexRatePerMinute: Number(process.env.GEMINI2_VERTEX_RPM ?? 3800),
    disableCache: process.env.EMBED_CACHE_DISABLED === '1',
  };
}
