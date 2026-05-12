/**
 * Cost key mapping: tool name + params → cost_key for Portal billing.
 *
 * Portal uses cost_key to look up base_cost from economics config,
 * apply reputation/holder discounts, and return effective_cost.
 *
 * Hardcoded — changes only when new tools are added.
 */

export function getCostKey(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    // Search — cost varies by strategy
    case 'search':
      return `search:${args.strategy ?? 'fast'}`;
    case 'search_semantic':
      return `search_semantic:${args.strategy ?? 'fast'}`;

    // Publishing — cost varies by content format
    case 'submit_document':
      return `submit_document:${args.content_format ?? 'latex'}`;

    // Search v2 (openarx-g8af) — variants by mode/detail differ in LLM cost
    case 'find_evidence':
      // fast = HyDE (2 LLM); deep = HyDE + per-chunk NLI (~10 LLM)
      return `find_evidence:${args.mode ?? 'fast'}`;
    case 'compare_papers':
      // standard = pure PG; full = + LLM summarization
      return args.detail === 'full' ? 'compare_papers:full' : 'compare_papers';
    case 'find_methodology':
      // standard/full = + LLM extraction per result; minimal = no LLM
      return args.detail === 'minimal' ? 'find_methodology:minimal' : 'find_methodology';

    // All other tools — tool name IS the cost_key.
    // Covers: search_keyword, get_document, get_chunks, paginate,
    //         find_benchmark_results, explore_topic, find_related,
    //         find_code, find_by_id, get_system_stats,
    //         submit_document (with format suffix above), pub/gov tools, etc.
    default:
      return tool;
  }
}
