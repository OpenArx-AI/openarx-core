/**
 * PortalDocQueue — in-memory processing queue for Portal-submitted documents.
 *
 * When POST /api/internal/ingest-document creates a document, it's added to
 * this queue. A background worker processes documents through the full pipeline
 * (Parse → Translate → Chunk → Enrich → Embed → Index).
 *
 * Independent from the Runner daemon (which handles arXiv papers only).
 * Max 2 documents processed concurrently. Queue capacity: 20.
 */

import type { Document } from '@openarx/types';
import { PipelineOrchestrator, type OrchestratorConfig } from '@openarx/ingest';
import {
  PgDocumentStore,
  QdrantVectorStore,
  DefaultModelRouter,
  EmbedClient,
  query,
} from '@openarx/api';

const MAX_QUEUE_SIZE = 20;
const MAX_CONCURRENT = 2;

interface QueueItem {
  document: Document;
  addedAt: Date;
}

export class PortalDocQueue {
  private queue: QueueItem[] = [];
  private processing = 0;
  private orchestrator: PipelineOrchestrator | null = null;
  private started = false;

  async init(): Promise<void> {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const googleAiKey = process.env.GOOGLE_AI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!openrouterKey && !googleAiKey) {
      console.error('[portal-queue] No LLM API key — portal doc processing disabled');
      return;
    }

    const documentStore = new PgDocumentStore();
    const vectorStore = new QdrantVectorStore();
    const modelRouter = new DefaultModelRouter({
      anthropicApiKey: anthropicKey ?? '',
      openrouterApiKey: openrouterKey ?? '',
      googleAiApiKey: googleAiKey,
    });

    const embedServiceUrl = process.env.EMBED_SERVICE_URL;
    const internalSecret = process.env.CORE_INTERNAL_SECRET;
    if (!embedServiceUrl || !internalSecret) {
      console.error('[portal-queue] EMBED_SERVICE_URL and CORE_INTERNAL_SECRET are required — portal doc processing disabled');
      return;
    }
    const embedClient = new EmbedClient({ url: embedServiceUrl, secret: internalSecret });

    const config: OrchestratorConfig = { embedClient };

    this.orchestrator = new PipelineOrchestrator(
      documentStore, vectorStore, modelRouter, config,
    );

    // Recover: pick up portal docs stuck in 'downloaded' from previous restart
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM documents WHERE source = 'portal' AND status = 'downloaded' ORDER BY created_at ASC LIMIT $1`,
      [MAX_QUEUE_SIZE],
    );

    if (rows.length > 0) {
      for (const row of rows) {
        const doc = await documentStore.getById(row.id);
        if (doc) this.queue.push({ document: doc, addedAt: new Date() });
      }
      console.error(`[portal-queue] Recovered ${rows.length} pending portal doc(s) from DB`);
    }

    this.started = true;
    this.drain();

    console.error(`[portal-queue] Initialized (max queue: ${MAX_QUEUE_SIZE}, max concurrent: ${MAX_CONCURRENT})`);
  }

  /**
   * Add a document to the processing queue.
   * Returns true if added, false if queue is full.
   */
  enqueue(document: Document): boolean {
    if (this.queue.length >= MAX_QUEUE_SIZE) return false;

    this.queue.push({ document, addedAt: new Date() });
    console.error(`[portal-queue] Enqueued ${document.sourceId} (queue: ${this.queue.length}, processing: ${this.processing})`);

    this.drain();
    return true;
  }

  /** Current queue position for a document (0-based), or -1 if not in queue. */
  queuePosition(documentId: string): number {
    return this.queue.findIndex((item) => item.document.id === documentId);
  }

  get queueSize(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.processing;
  }

  get isReady(): boolean {
    return this.started && this.orchestrator !== null;
  }

  /** Start processing queued documents up to concurrency limit. */
  private drain(): void {
    while (this.processing < MAX_CONCURRENT && this.queue.length > 0 && this.orchestrator) {
      const item = this.queue.shift()!;
      this.processing++;
      this.processDocument(item).finally(() => {
        this.processing--;
        this.drain();
      });
    }
  }

  private async processDocument(item: QueueItem): Promise<void> {
    const { document } = item;
    const startMs = Date.now();

    try {
      console.error(`[portal-queue] Processing ${document.sourceId} (${document.title.slice(0, 60)}...)`);

      const result = await this.orchestrator!.processOneDoc(document);

      const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
      console.error(`[portal-queue] ${document.sourceId} → ${result.status} (${durationSec}s)`);
    } catch (err) {
      const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
      console.error(`[portal-queue] ${document.sourceId} → error (${durationSec}s): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
