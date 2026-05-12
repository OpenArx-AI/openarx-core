// @openarx/ingest — source adapters + processing pipeline

// Utilities
export { logger, createChildLogger } from './lib/logger.js';
export { retry } from './lib/retry.js';

// License normalizer
export { normalizeLicense, isOpenLicense, computeEffectiveLicense, LICENSE_SOURCE_PRIORITY } from './lib/license-normalizer.js';
export type { SpdxLicense, LicenseInfo } from './lib/license-normalizer.js';

// Source adapters
export { ArxivLocalAdapter } from './adapters/arxiv-local.js';

// Pipeline steps
export { PgCostTracker } from './pipeline/cost-tracker.js';
export { ParserStep } from './pipeline/parser-step.js';
export { ChunkerStep } from './pipeline/chunker-step.js';
export { EnricherStep } from './pipeline/enricher-step.js';
export type { EnricherStepInput, EnricherStepConfig } from './pipeline/enricher-step.js';
export { IndexerStep } from './pipeline/indexer-step.js';
export { PipelineOrchestrator } from './pipeline/orchestrator.js';
export type { ProcessingReport, OrchestratorConfig } from './pipeline/orchestrator.js';

// Enricher sub-modules
export { extractGitHubUrls, extractDatasetNames, extractBenchmarkPatterns } from './pipeline/enricher/regex-extractor.js';
export { PwcLoader } from './pipeline/enricher/pwc-loader.js';
export type { PwcEntry, PwcRepo } from './pipeline/enricher/pwc-loader.js';
export { GitHubVerifier } from './pipeline/enricher/github-verifier.js';
export { BenchmarkExtractor } from './pipeline/enricher/benchmark-extractor.js';

// Quality metrics
export { computeQualityMetrics } from './lib/quality-metrics.js';

// Content review — aspect 1 (spam screen) for Portal publish gate
// (contracts/content_review.md / openarx-contracts-4pd)
export { runSpamScreen, parseLlmResponse as parseSpamScreenLlmResponse } from './pipeline/review/spam-screen.js';
export type {
  SpamVerdict as SpamScreenVerdict,
  SpamReason as SpamScreenReason,
  SpamReasonCode as SpamScreenReasonCode,
  SpamScreenInput,
  SpamScreenResult,
  SpamScreenModelRouter,
  SpamScreenDeps,
} from './pipeline/review/spam-screen.js';

// Dedup
export { normalizeTitle, titleSimilarity, textSimilarity, findDuplicates } from './lib/dedup.js';
export type { DuplicatePair } from './lib/dedup.js';

// Parsers
export { parseWithGrobid, checkGrobidHealth } from './parsers/grobid-client.js';
export { parseWithDocling, checkDoclingHealth } from './parsers/docling-client.js';
export { parseWithMathpix } from './parsers/mathpix-parser.js';
export type { MathpixConfig } from './parsers/mathpix-parser.js';
