// ── mcp_profiles_v4 role-gate (F2.7) — LIVE ──────────────────────────────────
//
// The role-gate: the Core-v4 gateway reads ONLY `token_type` from verify-token
// (§8 — no scopes/permissions) and serves that role's tools/list. `roleFor` IS the
// gate. LIVE since the Phase-3 cutover: index.ts main() serves token_type=researcher|
// governance via V4_ROLES (the advertised surface at /versions, v4.0.0). The v3 profiles
// remain only as superseded compatibility facades for legacy tokens (no v3 tokens exist
// post-cutover). [Was "BUILD-only / Phase-3-pending" pre-cutover — updated to reflect live.]

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
