// ── mcp_profiles_v4 role-gate (F2.7) — mount-ready ───────────────────────────
//
// The role-gate: the Core-v4 gateway reads ONLY `token_type` from verify-token
// (§8 — no scopes/permissions) and serves that role's tools/list. `roleFor` IS the
// gate. BUILD-only here; the gateway swap deploys synchronously with Portal-v4's
// verify-token change in the Phase 3 window (removing scopes breaks the live v3 path,
// so there is no risk-free additive-earlier part — it ships as one piece).

import { RESEARCHER } from './researcher.js';
import { GOVERNANCE } from './governance.js';
import type { V4Role, TokenType } from './types.js';

export type { V4Role, TokenType } from './types.js';
export { RESEARCHER } from './researcher.js';
export { GOVERNANCE } from './governance.js';

export const V4_ROLES: Record<TokenType, V4Role> = {
  researcher: RESEARCHER,
  governance: GOVERNANCE,
};

/** The role-gate: map a verify-token `token_type` to its role (undefined if unknown). */
export function roleFor(tokenType: string): V4Role | undefined {
  return tokenType === 'researcher' || tokenType === 'governance' ? V4_ROLES[tokenType] : undefined;
}
