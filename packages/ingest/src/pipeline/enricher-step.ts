/**
 * EnricherStep — orchestrates sub-extractors to populate document linkage fields.
 *
 * Flow:
 * 1. Regex extract GitHub URLs + dataset names from chunk text
 * 2. PwC lookup by arXiv ID for repos + datasets
 * 3. Merge + deduplicate GitHub URLs, verify via HEAD check
 * 4. Tiered benchmark extraction (regex → tables → LLM)
 * 5. Set document.codeLinks, datasetLinks, benchmarkResults
 * 6. Set chunk metrics: has_code, has_dataset on relevant chunks
 */

import type {
  Chunk,
  CodeLink,
  DatasetLink,
  Document,
  ParsedDocument,
  PipelineContext,
  PipelineStep,
} from '@openarx/types';
import {
  extractGitHubUrls,
  extractDatasetNames,
} from './enricher/regex-extractor.js';
import type { PwcLoader } from './enricher/pwc-loader.js';
import { GitHubVerifier } from './enricher/github-verifier.js';
import { BenchmarkExtractor } from './enricher/benchmark-extractor.js';
import { extractCodeLinksWithLlm } from './enricher/code-extractor-llm.js';

export interface EnricherStepInput {
  document: Document;
  chunks: Chunk[];
  parsedDocument: ParsedDocument;
}

export interface EnricherStepConfig {
  pwcLoader?: PwcLoader;
}

export class EnricherStep implements PipelineStep<EnricherStepInput, EnricherStepInput> {
  readonly name = 'enricher';

  private readonly pwcLoader?: PwcLoader;
  private readonly githubVerifier = new GitHubVerifier();
  private readonly benchmarkExtractor = new BenchmarkExtractor();

  constructor(config?: EnricherStepConfig) {
    this.pwcLoader = config?.pwcLoader;
  }

  async process(
    input: EnricherStepInput,
    context: PipelineContext,
  ): Promise<EnricherStepInput> {
    const { document, chunks, parsedDocument } = input;
    const { logger } = context;

    // 1. Concat all chunk text for regex scanning
    const allText = chunks.map((c) => c.content).join('\n\n');

    // 2. Extract GitHub URLs from text
    const textGitHubUrls = extractGitHubUrls(allText);
    logger.debug(`Regex: found ${textGitHubUrls.length} GitHub URLs`);

    // 3. Extract dataset names from text
    const textDatasets: DatasetLink[] = extractDatasetNames(allText);
    logger.debug(`Regex: found ${textDatasets.length} datasets`);

    // 3b. extracted_metadata from chunking prompt (if available)
    const em = document.extractedMetadata;
    if (em?.code_urls?.length) {
      textGitHubUrls.push(...em.code_urls.filter((u) => u.includes('github.com')));
      logger.debug(`extracted_metadata: ${em.code_urls.length} code URLs`);
    }
    if (em?.dataset_mentions?.length) {
      const emDatasets: DatasetLink[] = em.dataset_mentions.map((name) => ({
        name,
        extractedFrom: 'chunking_metadata' as const,
      }));
      textDatasets.push(...emDatasets);
      logger.debug(`extracted_metadata: ${em.dataset_mentions.length} dataset mentions`);
    }

    // 4. PwC lookup
    let pwcGitHubUrls: string[] = [];
    let pwcCodeLinks: CodeLink[] = [];
    let pwcDatasets: DatasetLink[] = [];

    if (this.pwcLoader) {
      const pwcEntry = this.pwcLoader.lookup(document.sourceId);
      if (pwcEntry) {
        logger.debug(`PwC: found entry with ${pwcEntry.repos.length} repos, ${pwcEntry.datasets.length} datasets`);

        pwcGitHubUrls = pwcEntry.repos
          .filter((r) => r.url.includes('github.com'))
          .map((r) => r.url);

        pwcCodeLinks = pwcEntry.repos.map((r) => ({
          repoUrl: r.url,
          stars: r.stars,
          language: r.language,
          extractedFrom: 'pwc_archive' as const,
        }));

        pwcDatasets = pwcEntry.datasets.map((name) => ({
          name,
          extractedFrom: 'pwc_archive' as const,
        }));
      }
    }

    // 5. Merge + deduplicate GitHub URLs for verification
    const allGitHubUrls = this.deduplicateUrls([...textGitHubUrls, ...pwcGitHubUrls]);

    // 6. Verify text-extracted URLs (PwC URLs are trusted)
    const textUrlSet = new Set(textGitHubUrls.map((u) => u.toLowerCase()));
    const urlsToVerify = allGitHubUrls.filter((u) => textUrlSet.has(u.toLowerCase()));
    const verifiedTextLinks = await this.githubVerifier.verify(urlsToVerify);

    // 7. Combine code links: verified text links + PwC links (deduplicated)
    let codeLinks = this.deduplicateCodeLinks([...verifiedTextLinks, ...pwcCodeLinks]);

    // 7b. LLM fallback (only if PwC + regex found 0 code links)
    if (codeLinks.length === 0) {
      try {
        const llmUrls = await extractCodeLinksWithLlm(chunks, context);
        if (llmUrls.length > 0) {
          const llmVerified = await this.githubVerifier.verify(llmUrls);
          codeLinks = llmVerified;
          logger.info(`LLM code extraction: ${llmVerified.length} verified`);
        }
      } catch (err) {
        logger.warn(`LLM code extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 8. Merge + deduplicate dataset links
    const datasetLinks = this.deduplicateDatasetLinks([...textDatasets, ...pwcDatasets]);

    // 9. Benchmark extraction (tiered)
    const benchmarkResults = await this.benchmarkExtractor.extract(
      parsedDocument,
      chunks,
      context,
    );

    // 10. Set document fields
    document.codeLinks = codeLinks;
    document.datasetLinks = datasetLinks;
    document.benchmarkResults = benchmarkResults;

    // 11. Set chunk metrics
    this.setChunkMetrics(chunks, codeLinks, datasetLinks);

    logger.info(
      `Enrichment complete: ${codeLinks.length} code links, ${datasetLinks.length} datasets, ${benchmarkResults.length} benchmarks`,
    );

    return { document, chunks, parsedDocument };
  }

  private setChunkMetrics(
    chunks: Chunk[],
    codeLinks: CodeLink[],
    datasetLinks: DatasetLink[],
  ): void {
    const repoPatterns = codeLinks.map((l) => {
      // Extract "owner/repo" from URL for matching in chunk text
      const match = /github\.com\/([\w.-]+\/[\w.-]+)/.exec(l.repoUrl);
      return match ? match[1].toLowerCase() : l.repoUrl.toLowerCase();
    });

    const datasetNames = datasetLinks.map((d) => d.name.toLowerCase());

    for (const chunk of chunks) {
      const lower = chunk.content.toLowerCase();

      const hasCode = repoPatterns.some(
        (p) => lower.includes(p) || lower.includes('github.com'),
      );
      const hasDataset = datasetNames.some((d) => lower.includes(d));

      if (hasCode) {
        chunk.metrics.has_code = {
          value: true,
          version: '1.0',
          computedAt: new Date(),
        };
      }
      if (hasDataset) {
        chunk.metrics.has_dataset = {
          value: true,
          version: '1.0',
          computedAt: new Date(),
        };
      }
    }
  }

  private deduplicateUrls(urls: string[]): string[] {
    const seen = new Set<string>();
    return urls.filter((url) => {
      const key = url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private deduplicateCodeLinks(links: CodeLink[]): CodeLink[] {
    const seen = new Map<string, CodeLink>();
    for (const link of links) {
      const key = link.repoUrl.toLowerCase();
      const existing = seen.get(key);
      // Prefer links with more metadata (stars, language)
      if (!existing || (link.stars && !existing.stars)) {
        seen.set(key, link);
      }
    }
    return Array.from(seen.values());
  }

  private deduplicateDatasetLinks(links: DatasetLink[]): DatasetLink[] {
    const seen = new Map<string, DatasetLink>();
    for (const link of links) {
      const key = link.name.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, link);
      }
    }
    return Array.from(seen.values());
  }
}
