import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';

export interface McpProfile {
  /** URL prefix: 'v1', 'dev' — used in /:profile/mcp routing */
  id: string;
  /** Human-readable name shown in /versions */
  name: string;
  /** Description of what this profile does */
  description: string;
  /** SemVer for serverInfo.version */
  version: string;
  /** Minimum token type required to access this profile */
  minTokenType: 'consumer' | 'publisher' | 'gov_participant';
  /** Register all tools on the McpServer instance */
  registerTools(server: McpServer, ctx: AppContext): void;
}

/** Token type hierarchy: higher types inherit access to lower-level profiles */
const TOKEN_TYPE_LEVEL: Record<string, number> = {
  consumer: 1,
  publisher: 2,
  gov_participant: 3,
};

/** Check if user's token type meets the minimum required for a profile */
export function isTokenTypeSufficient(userType: string | undefined, required: string): boolean {
  return (TOKEN_TYPE_LEVEL[userType ?? 'consumer'] ?? 0) >= (TOKEN_TYPE_LEVEL[required] ?? 0);
}
