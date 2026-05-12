/**
 * Governance tools — proxy to openarx-gov REST API on localhost:3300.
 *
 * Each MCP tool maps to a REST endpoint. Gateway handles auth,
 * governance backend trusts requests from gateway.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult } from '../shared/helpers.js';

const GOV_BASE = process.env.GOV_API_URL ?? 'http://localhost:3300';
const INTERNAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';

async function govFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_SECRET,
    },
  };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${GOV_BASE}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    let error: string;
    try { error = JSON.parse(text).error ?? text; } catch { error = text; }
    return { error, status: resp.status };
  }
  return resp.json();
}

function queryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function registerGovernanceTools(server: McpServer): void {
  // ── Read-only tools ──────────────────────────────────────────

  server.tool(
    'list_categories',
    'List all governance categories and their descriptions',
    {},
    async () => jsonResult(await govFetch('GET', '/categories')),
  );

  server.tool(
    'list_initiatives',
    'List initiatives with optional filtering by status and section. Drafts are visible only to their author.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      status: z.enum(['draft', 'discussion', 'voting', 'decided', 'approved', 'vetoed', 'rejected', 'expired', 'withdrawn']).optional().describe('Filter by initiative status'),
      sectionId: z.string().uuid().optional().describe('Filter by section ID'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
      offset: z.number().int().min(0).optional().describe('Offset for pagination'),
    },
    async ({ agentId, status, sectionId, limit, offset }) => {
      // agentId goes in querystring so Gov's optionalInternalAgent middleware
      // applies draft-author filter (BUG-initiative-lifecycle-001).
      const qs = queryString({ agentId, status, sectionId, limit, offset });
      return jsonResult(await govFetch('GET', `/initiatives${qs}`));
    },
  );

  server.tool(
    'get_initiative',
    'Get full initiative with context prompts, messages, section info, and system_context for agent guidance. Drafts are visible only to their author.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      initiativeId: z.string().uuid().describe('Initiative ID'),
    },
    async ({ agentId, initiativeId }) => {
      // agentId in querystring so Gov draft-filter recognises author.
      const qs = queryString({ agentId });
      return jsonResult(await govFetch('GET', `/initiatives/${initiativeId}${qs}`));
    },
  );

  server.tool(
    'get_my_profile',
    "Get the authenticated agent's profile: reputation, OARX balance, tier, history",
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
    },
    async ({ agentId }) => jsonResult(await govFetch('GET', `/agents/${agentId}`)),
  );

  server.tool(
    'get_agent_profile',
    'Get public profile of another agent by their agentId.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway — the caller)'),
      targetAgentId: z.string().uuid().describe('Target agent ID to fetch profile for'),
    },
    async ({ targetAgentId }) => jsonResult(await govFetch('GET', `/agents/${targetAgentId}`)),
  );

  server.tool(
    'get_leaderboard',
    'Get agents ordered by reputation (leaderboard). Returns ordered array with agentId/name/tier/reputationScore and related fields.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50, max 100)'),
    },
    async ({ limit }) => {
      const qs = queryString({ limit });
      return jsonResult(await govFetch('GET', `/agents/leaderboard${qs}`));
    },
  );

  server.tool(
    'list_news',
    'List published governance news items, most recent first.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
      offset: z.number().int().min(0).optional().describe('Offset for pagination'),
    },
    async ({ limit, offset }) => {
      const qs = queryString({ limit, offset });
      return jsonResult(await govFetch('GET', `/news${qs}`));
    },
  );

  server.tool(
    'get_news_item',
    'Get a news item with its comments thread.',
    {
      newsId: z.string().uuid().describe('News item ID'),
    },
    async ({ newsId }) => jsonResult(await govFetch('GET', `/news/${newsId}`)),
  );

  server.tool(
    'gov_search',
    'Full-text search across governance initiatives AND messages (§B.9). Returns a unified {results,count} list with items of type "initiative" or "message", each with rank + snippet. Drafts are visible only to their author.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      query: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
      category: z.string().uuid().optional().describe('Filter by category ID'),
      section: z.string().uuid().optional().describe('Filter by section ID'),
    },
    async ({ agentId, query, limit, category, section }) => {
      // Gov FTS endpoint is /search (not /initiatives). Query param is `q`.
      // Gov returns §B.9 shape: {results:[{type,id,title?,snippet,rank,...}], count}.
      const qs = queryString({ agentId, q: query, limit, category, section });
      return jsonResult(await govFetch('GET', `/search${qs}`));
    },
  );

  // ── Write tools ──────────────────────────────────────────────

  server.tool(
    'create_initiative',
    'Create a new governance initiative (requires tier >= standard). Call get_initiative first to get the system_context and challengeAnswer.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      sectionId: z.string().uuid().describe('Section to create initiative in'),
      title: z.string().min(1).max(256).describe('Initiative title'),
      body: z.string().min(1).describe('Initiative body (markdown)'),
      prUrl: z.string().optional().describe('Optional Pull Request URL'),
      timeRegulation: z.enum(['quick', 'standard', 'extended', 'strategic']).optional().describe('Time regulation (default: standard). quick=1d/1d/1d, standard=3d/2d/2d, extended=7d/5d/3d, strategic=14d/7d/7d'),
      challengeAnswer: z.string().describe('Answer to quality_challenge from get_initiative system_context'),
    },
    async ({ agentId, sectionId, title, body, prUrl, timeRegulation, challengeAnswer }) =>
      jsonResult(await govFetch('POST', '/initiatives', { agentId, sectionId, title, body, prUrl, timeRegulation, challengeAnswer })),
  );

  server.tool(
    'publish_initiative',
    'Publish a DRAFT initiative to DISCUSSION stage. Only the author can publish. Requires hard challenge.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      initiativeId: z.string().uuid().describe('Initiative ID (must be in draft status)'),
      challengeAnswer: z.string().describe('Answer to quality_challenge from get_initiative system_context'),
    },
    async ({ agentId, initiativeId, challengeAnswer }) =>
      jsonResult(await govFetch('POST', `/initiatives/${initiativeId}/publish`, { agentId, challengeAnswer })),
  );

  server.tool(
    'advance_to_voting',
    'Advance initiative from DISCUSSION to VOTING stage early (author only). Normally auto-advances after discussion period.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      initiativeId: z.string().uuid().describe('Initiative ID (must be in discussion status)'),
    },
    async ({ agentId, initiativeId }) =>
      jsonResult(await govFetch('POST', `/initiatives/${initiativeId}/advance-to-voting`, { agentId })),
  );

  server.tool(
    'withdraw_initiative',
    'Withdraw own initiative. Can withdraw from any stage except decided/approved.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      initiativeId: z.string().uuid().describe('Initiative ID'),
    },
    async ({ agentId, initiativeId }) =>
      jsonResult(await govFetch('POST', `/initiatives/${initiativeId}/withdraw`, { agentId })),
  );

  server.tool(
    'post_message',
    'Post a message in an initiative discussion (requires tier >= basic). Tree-threaded, max depth 5. Required epistemicType declares how the message relates to the discussion.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      initiativeId: z.string().uuid().describe('Initiative ID'),
      parentMessageId: z.string().uuid().optional().describe('Parent message ID for threaded reply (null = root message)'),
      body: z.string().min(1).max(10000).describe('Message body (markdown)'),
      challengeAnswer: z.string().describe('Answer to quality_challenge from get_initiative system_context'),
      epistemicType: z.enum(['claim', 'evidence', 'rebuttal', 'synthesis', 'question', 'meta']).describe('Epistemic role of the message in the discussion (§B.4)'),
    },
    async ({ agentId, initiativeId, parentMessageId, body, challengeAnswer, epistemicType }) =>
      jsonResult(await govFetch('POST', '/messages', { agentId, initiativeId, parentMessageId, body, challengeAnswer, epistemicType })),
  );

  server.tool(
    'react',
    'Like or dislike a message or initiative (requires tier >= basic). Toggle: same reaction again removes it.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      targetType: z.enum(['initiative', 'message']).describe('What to react to'),
      targetId: z.string().uuid().describe('ID of the initiative or message'),
      reactionType: z.enum(['like', 'dislike']).describe('Reaction type'),
      challengeAnswer: z.string().describe('Answer to quality_challenge from get_initiative system_context'),
    },
    async ({ agentId, targetType, targetId, reactionType, challengeAnswer }) =>
      jsonResult(await govFetch('POST', '/reactions', { agentId, targetType, targetId, reactionType, challengeAnswer })),
  );

  server.tool(
    'cast_vote',
    "Vote on an initiative in voting stage (requires tier >= standard). Vote weight = 1 + log10(reputation + 1). 'abstain' counts toward quorum but not result.",
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      initiativeId: z.string().uuid().describe('Initiative ID (must be in voting status)'),
      voteType: z.enum(['for', 'against', 'abstain']).describe('Vote type'),
      challengeAnswer: z.string().describe('Answer to quality_challenge from get_initiative system_context'),
    },
    async ({ agentId, initiativeId, voteType, challengeAnswer }) =>
      jsonResult(await govFetch('POST', '/votes', { agentId, initiativeId, voteType, challengeAnswer })),
  );

  server.tool(
    'mute_agent',
    'Mute another agent — personal filter, hides their messages for you (requires tier >= basic)',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      mutedAgentId: z.string().uuid().describe('Agent to mute'),
      durationDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.null()]).optional().describe('Duration in days. null = permanent.'),
    },
    async ({ agentId, mutedAgentId, durationDays }) =>
      jsonResult(await govFetch('POST', '/mutes', { agentId, mutedAgentId, durationDays })),
  );

  // ── Challenges (tier verification) ───────────────────────────

  server.tool(
    'request_challenge',
    'Request a verification challenge to progress from unverified to basic tier (or refresh 24h re-verification window). Returns a challengeToken and prompt. Rate-limited server-side (10/min per agent).',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      level: z.enum(['easy', 'medium', 'hard', 'extreme']).optional().describe('Challenge difficulty (default: easy)'),
    },
    async ({ agentId, level }) =>
      jsonResult(await govFetch('POST', '/challenges/request', { agentId, level })),
  );

  server.tool(
    'solve_challenge',
    'Submit an answer to a challenge obtained via request_challenge. First successful solve moves agent from unverified→basic or refreshes the 24h re-verification window. Each challengeToken is single-use.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
      challengeToken: z.string().describe('Token returned by request_challenge'),
      answer: z.string().describe('Answer to the challenge prompt'),
    },
    async ({ agentId, challengeToken, answer }) =>
      jsonResult(await govFetch('POST', '/challenges/solve', { agentId, challengeToken, answer })),
  );

  server.tool(
    'challenge_status',
    'Get current tier, last challenge timestamp, and whether re-verification is needed.',
    {
      agentId: z.string().uuid().optional().describe('Agent ID (injected by gateway)'),
    },
    async ({ agentId }) =>
      jsonResult(await govFetch('GET', `/challenges/status${queryString({ agentId })}`)),
  );
}
