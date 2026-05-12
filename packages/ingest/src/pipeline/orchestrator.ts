/**
 * PipelineOrchestrator — sequential step execution with status management.
 *
 * processAll(): fetch 'downloaded' documents, process each
 * processOne(): downloaded → parsing → chunking → embedding → ready
 * retryFailed(): fetch 'failed' documents, re-process
 */

import type {
  Document,
  DocumentStore,
  ModelRouter,
  ParsedSection,
  VectorStore,
} from '@openarx/types';
import type { EmbedClient } from '@openarx/api';
import { PgChunkStore } from '@openarx/api';

import { createChildLogger } from '../lib/logger.js';
import { ParserStep } from './parser-step.js';
import { ChunkerStep } from './chunker-step.js';
import { EnricherStep } from './enricher-step.js';
import { IndexerStep } from './indexer-step.js';
import type { PwcLoader } from './enricher/pwc-loader.js';
import { DocumentOrchestrator } from './document-orchestrator.js';

interface StageTiming {
  parseMs: number;
  chunkMs: number;
  enrichMs: number;
  embedMs: number;
  indexMs: number;
  totalMs: number;
  chunkBatches?: number;
  chunkCount?: number;
  enrichCodeLinks?: number;
  enrichDatasets?: number;
  enrichBenchmarks?: number;
}

const log = createChildLogger('orchestrator');

export interface ProcessingReport {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{
    documentId: string;
    sourceId: string;
    status: 'ready' | 'failed' | 'duplicate';
    chunks?: number;
    error?: string;
    durationMs: number;
  }>;
}

export interface OrchestratorConfig {
  pwcLoader?: PwcLoader;
  /** Required: all chunk embeddings route through openarx-embed-service. */
  embedClient: EmbedClient;
}

export class PipelineOrchestrator {
  private readonly documentStore: DocumentStore;
  private readonly vectorStore: VectorStore;
  private readonly modelRouter: ModelRouter;
  private readonly config: OrchestratorConfig;

  private readonly parserStep = new ParserStep();
  private readonly chunkerStep = new ChunkerStep();
  private readonly enricherStep: EnricherStep;
  private readonly indexerStep: IndexerStep;
  private readonly chunkStore = new PgChunkStore();

  constructor(
    documentStore: DocumentStore,
    vectorStore: VectorStore,
    modelRouter: ModelRouter,
    config: OrchestratorConfig,
  ) {
    this.documentStore = documentStore;
    this.vectorStore = vectorStore;
    this.modelRouter = modelRouter;
    this.config = config;
    this.enricherStep = new EnricherStep({ pwcLoader: this.config.pwcLoader });
    this.indexerStep = new IndexerStep({ vectorStore });
  }

  async processAll(limit = 100, _concurrency = 1, pipelineRunId?: string, stopSignal?: { requested: boolean }, strategy?: 'license_aware' | 'force_full', bypassEmbedCache?: boolean): Promise<ProcessingReport> {
    const documents = await this.documentStore.listByStatus('downloaded', limit);
    log.info({ count: documents.length, limit, strategy: strategy ?? 'default', bypassEmbedCache: !!bypassEmbedCache }, 'Processing downloaded documents');
    return this.runPool(documents, pipelineRunId, stopSignal, strategy, bypassEmbedCache);
  }

  async retryFailed(limit = 100, _concurrency = 1): Promise<ProcessingReport> {
    const documents = await this.documentStore.listByStatus('failed', limit);
    log.info({ count: documents.length, limit }, 'Retrying failed documents');

    // Reset status to downloaded for re-processing
    for (const doc of documents) {
      await this.documentStore.updateStatus(doc.id, 'downloaded', {
        step: 'retry',
        status: 'started',
        timestamp: new Date().toISOString(),
      });
    }

    return this.runPool(documents);
  }

  async processOne(documentId: string): Promise<void> {
    const doc = await this.documentStore.getById(documentId);
    if (!doc) throw new Error(`Document not found: ${documentId}`);

    const report = await this.runPool([doc]);
    if (report.failed > 0) {
      throw new Error(`Processing failed for ${documentId}: ${report.results[0]?.error}`);
    }
  }

  /**
   * Process a single document through the pool pipeline.
   * Used by the continuous sliding window consumer — no batch boundaries.
   * Creates a lightweight DocumentOrchestrator context per call.
   */
  private _sharedOrch: DocumentOrchestrator | null = null;
  private _sharedOrchRunId: string | null = null;

  async processOneDoc(
    doc: Document,
    pipelineRunId?: string,
    stopSignal?: { requested: boolean },
    strategy?: 'license_aware' | 'force_full',
    bypassEmbedCache?: boolean,
  ): Promise<ProcessingReport['results'][number]> {
    // Reuse DocumentOrchestrator for the same run (shares resource pool)
    if (!this._sharedOrch || this._sharedOrchRunId !== pipelineRunId) {
      this._sharedOrch = new DocumentOrchestrator(
        {
          documentStore: this.documentStore,
          parserStep: this.parserStep,
          chunkerStep: this.chunkerStep,
          enricherStep: this.enricherStep,
          indexerStep: this.indexerStep,
          modelRouter: this.modelRouter,
          embedClient: this.config.embedClient,
          chunkStore: this.chunkStore,
          vectorStore: this.vectorStore,
          bypassEmbedCache: bypassEmbedCache === true,
        },
        { pipelineRunId, stopSignal, strategy },
      );
      this._sharedOrchRunId = pipelineRunId ?? null;
    }

    const result = await this._sharedOrch.processOne(doc);
    this._sharedOrch.updatePipelineRun(result);
    return result;
  }

  private async runPool(documents: Document[], pipelineRunId?: string, stopSignal?: { requested: boolean }, strategy?: 'license_aware' | 'force_full', bypassEmbedCache?: boolean): Promise<ProcessingReport> {
    const orch = new DocumentOrchestrator(
      {
        documentStore: this.documentStore,
        parserStep: this.parserStep,
        chunkerStep: this.chunkerStep,
        enricherStep: this.enricherStep,
        indexerStep: this.indexerStep,
        modelRouter: this.modelRouter,
        embedClient: this.config.embedClient,
        chunkStore: this.chunkStore,
        vectorStore: this.vectorStore,
        bypassEmbedCache: bypassEmbedCache === true,
      },
      { pipelineRunId, stopSignal, strategy },
    );
    return orch.processDocuments(documents);
  }

}

// Unicode math operators, Greek letters, sub/superscripts, LaTeX patterns
const MATH_RE =
  /[\u2200-\u22FF\u0391-\u03C9\u00B2\u00B3\u00B9\u2070-\u209F]|\\(?:frac|sum|int|alpha|beta|gamma|delta|theta|lambda|sigma|omega|infty|partial|nabla|sqrt|prod|lim)\b/;

/** Estimate math density from parsed sections without needing chunks. */
function estimateMathDensity(sections: ParsedSection[]): number {
  let total = 0;
  let withMath = 0;

  function visit(secs: ParsedSection[]): void {
    for (const s of secs) {
      if (s.content.trim()) {
        total++;
        if (MATH_RE.test(s.content)) withMath++;
      }
      if (s.subsections) visit(s.subsections);
    }
  }

  visit(sections);
  return total > 0 ? withMath / total : 0;
}
