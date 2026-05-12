/**
 * Shared search-suite registration — single source of truth for all
 * v2 search tools that are inherited by every profile (consumer/v1,
 * publisher/pub, gov_participant/gov).
 *
 * Composition over inheritance (openarx-i3x3): each profile composes
 * this suite + its own incremental tools, instead of re-listing every
 * registration. Adding a new search tool = update this file once;
 * pub and gov inherit automatically.
 *
 * Pre-refactor state (search v2 Stage 2-4 regression): pub and gov
 * profiles were copy-pasting the legacy 6-tool subset, missing the 9
 * v2 additions (search_keyword, search_semantic, get_chunks, paginate,
 * find_benchmark_results, compare_papers, explore_topic,
 * find_methodology, find_evidence). This shared suite fixes that.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';

import { registerSearch } from '../v1/search.js';
import { registerSearchKeyword } from '../v1/search-keyword.js';
import { registerSearchSemantic } from '../v1/search-semantic.js';
import { registerGetChunks } from '../v1/get-chunks.js';
import { registerPaginate } from '../v1/paginate.js';
import { registerFindBenchmarkResults } from '../v1/find-benchmark-results.js';
import { registerComparePapers } from '../v1/compare-papers.js';
import { registerExploreTopic } from '../v1/explore-topic.js';
import { registerFindMethodology } from '../v1/find-methodology.js';
import { registerFindEvidence } from '../v1/find-evidence.js';
import { registerGetDocument } from './get-document.js';
import { registerFindRelated } from './find-related.js';
import { registerFindCode } from './find-code.js';
import { registerFindById } from './find-by-id.js';
import { registerSystemStats } from './system-stats.js';

/**
 * Registers all 15 search-v2 tools on an McpServer instance. Called by
 * every profile (v1, pub, gov). Profiles add their own incremental
 * tools (publishing, governance) on top.
 *
 * Tool inventory (matches docs/mcp_search_v2_design.md §3.2):
 *   Group A — search variants (3): search, search_keyword, search_semantic
 *   Group B — specialized (5):     find_methodology, find_benchmark_results,
 *                                  find_evidence, compare_papers, explore_topic
 *   Group C — drill-down (4):      get_chunks, paginate, find_related,
 *                                  find_code
 *   Group D — direct lookup (3):   get_document, find_by_id,
 *                                  get_system_stats
 */
export function registerSearchSuite(server: McpServer, ctx: AppContext): void {
  // Group A — Core hybrid
  registerSearch(server, ctx);
  registerSearchKeyword(server, ctx);
  registerSearchSemantic(server, ctx);

  // Group B — Specialized lookups
  registerFindMethodology(server, ctx);
  registerFindBenchmarkResults(server, ctx);
  registerFindEvidence(server, ctx);
  registerComparePapers(server, ctx);
  registerExploreTopic(server, ctx);

  // Group C — Drill-down / ergonomics
  registerGetChunks(server, ctx);
  registerPaginate(server, ctx);
  registerFindRelated(server, ctx);
  registerFindCode(server, ctx);

  // Group D — Direct lookup
  registerGetDocument(server, ctx);
  registerFindById(server, ctx);
  registerSystemStats(server, ctx);
}
