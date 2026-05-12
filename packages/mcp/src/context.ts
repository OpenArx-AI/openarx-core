import {
  pool,
  PgDocumentStore,
  QdrantVectorStore,
  RerankerClient,
  SearchStore,
  DefaultModelRouter,
  EmbedClient,
  type EmbedderImpl,
  type EmbedModel,
} from '@openarx/api';
import { PortalDocQueue } from './portal-doc-queue.js';

export interface AppContext {
  documentStore: PgDocumentStore;
  vectorStore: QdrantVectorStore;
  searchStore: SearchStore;
  /** Bound to gemini-embedding-2-preview via embed-service. Same vector
   *  space as runner-produced chunk vectors. */
  geminiEmbedder: EmbedderImpl;
  /** Raw embed-service client — used for query-time SPECTER2 calls and
   *  any future model dispatch beyond the gemini default. */
  embedClient: EmbedClient;
  rerankerClient: RerankerClient;
  /** LLM router for MCP-side synchronous LLM calls (aspect 1 spam screen on
   *  /api/internal/ingest-document sync path — openarx-contracts-4pd).
   *  Async ingest pipeline uses its own instance via PortalDocQueue. */
  modelRouter: DefaultModelRouter;
  portalDocQueue: PortalDocQueue;
  pool: typeof pool;
  shutdown: () => Promise<void>;
  // Per-request UsageTracker for LLM/embed cost capture is NOT on the
  // shared context — would race across concurrent requests. Threaded via
  // AsyncLocalStorage in lib/usage-tracker.ts; tools call module-level
  // recordLlm() / recordEmbed() which look up the active tracker.
}

export function createContext(): AppContext {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const googleAiKey = process.env.GOOGLE_AI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openrouterKey && !googleAiKey) {
    throw new Error('OPENROUTER_API_KEY or GOOGLE_AI_API_KEY is required');
  }
  const embedServiceUrl = process.env.EMBED_SERVICE_URL;
  const internalSecret = process.env.CORE_INTERNAL_SECRET;
  if (!embedServiceUrl || !internalSecret) {
    throw new Error('EMBED_SERVICE_URL and CORE_INTERNAL_SECRET are required');
  }

  const documentStore = new PgDocumentStore();
  const vectorStore = new QdrantVectorStore();
  const searchStore = new SearchStore();
  // Query embeddings go through openarx-embed-service so MCP shares the
  // Redis cache + rate-limiter with the ingest pipeline. The model used
  // here must match what runner uses for chunk embeddings (same vector
  // space) — overrideable via MCP_GEMINI_MODEL for parity testing.
  const embedClient = new EmbedClient({ url: embedServiceUrl, secret: internalSecret });
  const queryModel = (process.env.MCP_GEMINI_MODEL ?? 'gemini-embedding-2-preview') as EmbedModel;
  const geminiEmbedder: EmbedderImpl = embedClient.forModel(queryModel);
  const rerankerClient = new RerankerClient();
  const modelRouter = new DefaultModelRouter({
    anthropicApiKey: anthropicKey ?? '',
    openrouterApiKey: openrouterKey ?? '',
    googleAiApiKey: googleAiKey,
  });
  const portalDocQueue = new PortalDocQueue();

  return {
    documentStore,
    vectorStore,
    searchStore,
    geminiEmbedder,
    embedClient,
    rerankerClient,
    modelRouter,
    portalDocQueue,
    pool,
    shutdown: async () => {
      await pool.end();
    },
  };
}
