// ── mcp_profiles_v4 role model (F2.7) ────────────────────────────────────────
//
// v4 abolishes `scope` (mechanism AND word). The gate is the ROLE: verify-token
// returns a flat `token_type ∈ {researcher, governance}` and the gateway builds
// `tools/list` from it — no per-tool sub-gate. This is the role definition the
// Core-v4 gateway mounts (§1/§2/§8). BUILD-only in Phase 2; the gateway swap + Portal-v4
// verify-token change deploy together in the Phase 3 window (scope removal breaks v3).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';

export type TokenType = 'researcher' | 'governance';

export interface V4Role {
  /** The token_type value that selects this role (verify-token, §8). */
  readonly token_type: TokenType;
  readonly name: string;
  readonly version: string;
  /** Register the role's full tool set — no scope filtering (§2). */
  registerTools(server: McpServer, ctx: AppContext): void;
}
