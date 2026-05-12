/**
 * MCP Request Logger — persistent per-request logging.
 *
 * Two outputs:
 * 1. JSONL file on NVMe (source of truth, daily rotation)
 * 2. Fire-and-forget POST to Portal (for user-facing usage history)
 *
 * Both are async and non-blocking — tool response is never delayed by logging.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = process.env.MCP_LOG_DIR ?? './data/mcp-logs';
const PORTAL_INTERNAL_URL = process.env.PORTAL_INTERNAL_URL ?? '';
const PORTAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';

/**
 * Raw per-call LLM/embed cost data captured during a tool invocation.
 * Source: ModelResponse / EmbedResponse from provider clients (Vertex,
 * OpenRouter, etc.). Aggregation totals are convenience for jq queries
 * — same as summing the arrays.
 *
 * `creditsCharged` (above) is Portal billing → user; cost fields here
 * are real provider USD spend → us. Different concepts, both useful.
 *
 * Filled by UsageTracker.snapshot() (lib/usage-tracker.ts).
 * See openarx-2a5f.
 */
export interface UsageLogFields {
  llmCalls: Array<{
    task: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    finishReason?: string;
  }> | null;
  embedCalls: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    costUsd: number;
  }> | null;
  llmCostUsdTotal: number;
  embedCostUsdTotal: number;
  llmInputTokensTotal: number;
  llmOutputTokensTotal: number;
}

export interface RequestLogEntry extends UsageLogFields {
  timestamp: string;
  userId: string | null;
  tokenId: string | null;
  tokenType: string | null;
  ip: string;
  userAgent: string;
  profile: string;
  tool: string;
  arguments: Record<string, unknown>;
  resultCount: number | null;
  topResults: Array<{ docId: string; score: number }> | null;
  durationMs: number;
  creditsCharged: number | null;
  error: string | null;
}

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // ignore — will fail on appendFile if truly broken
  }
}

function todayFilename(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}.jsonl`;
}

/**
 * Log a request to JSONL file and Portal DB.
 * Non-blocking — errors are logged to stderr, never thrown.
 */
export function logRequest(entry: RequestLogEntry): void {
  // 1. JSONL file (async, non-blocking)
  const line = JSON.stringify(entry) + '\n';
  ensureDir().then(() =>
    appendFile(join(LOG_DIR, todayFilename()), line).catch((err) => {
      console.error(`[request-logger] JSONL write failed: ${err instanceof Error ? err.message : err}`);
    }),
  );

  // 2. POST to Portal (fire-and-forget)
  if (PORTAL_INTERNAL_URL && PORTAL_SECRET) {
    fetch(`${PORTAL_INTERNAL_URL}/api/internal/log-mcp-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': PORTAL_SECRET,
      },
      body: line,
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      console.error(`[request-logger] Portal POST failed: ${err instanceof Error ? err.message : err}`);
    });
  }
}

/**
 * Extract result summary from tool response for logging.
 */
export function extractResultSummary(result: unknown): { resultCount: number | null; topResults: Array<{ docId: string; score: number }> | null } {
  try {
    const content = (result as { content?: Array<{ text?: string }> })?.content;
    if (!content?.[0]?.text) return { resultCount: null, topResults: null };

    const parsed = JSON.parse(content[0].text);

    // search tool returns { results: [...] }
    if (Array.isArray(parsed.results)) {
      return {
        resultCount: parsed.results.length,
        topResults: parsed.results.slice(0, 3).map((r: Record<string, unknown>) => ({
          docId: (r.documentId ?? r.document_id ?? '') as string,
          score: (r.finalScore ?? r.score ?? 0) as number,
        })),
      };
    }

    // get_document returns { document: {...} }
    if (parsed.document) {
      return { resultCount: 1, topResults: [{ docId: parsed.document.id ?? '', score: 1 }] };
    }

    return { resultCount: null, topResults: null };
  } catch {
    return { resultCount: null, topResults: null };
  }
}
