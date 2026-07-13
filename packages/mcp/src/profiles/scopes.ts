/**
 * Profiles v3 — token scopes (mcp_profiles_v3.md §3).
 *
 * Access differentiation is by token SCOPE, not by profile. The `researcher`
 * profile exposes the full role surface; the tool list a given token sees is
 * filtered to the scopes it holds. Read-only = a token without write scopes on
 * the same profile.
 *
 * Portal maps existing tokens automatically (no re-issue):
 *   consumer                    → [read]
 *   publisher / gov_participant → [read, write:documents, write:layer2]
 *
 * The methodist scope is issued separately (mentee credential), out of the
 * consumer/publisher mapping.
 */

export const SCOPE_READ = 'read';
export const SCOPE_WRITE_DOCUMENTS = 'write:documents';
export const SCOPE_WRITE_LAYER2 = 'write:layer2';
export const SCOPE_METHODIST = 'methodist';

/**
 * Tool → the scope required to see/call it on a scope-filtered profile.
 * A tool NOT listed here defaults to SCOPE_READ (meta/reads are read-gated; every
 * mapped token holds `read`), so an unmapped new read tool is safe by default and
 * a new WRITE tool must be added here explicitly.
 */
export const TOOL_REQUIRED_SCOPE: Record<string, string> = {
  // ── document writes ──
  submit_document: SCOPE_WRITE_DOCUMENTS,
  create_new_version: SCOPE_WRITE_DOCUMENTS,
  create_draft: SCOPE_WRITE_DOCUMENTS,
  create_upload_url: SCOPE_WRITE_DOCUMENTS,
  // ── Layer 2 writes (incl. verify_claim, which writes a verification block) ──
  submit_claim: SCOPE_WRITE_LAYER2,
  submit_relation: SCOPE_WRITE_LAYER2,
  submit_activity_batch: SCOPE_WRITE_LAYER2,
  submit_metrics: SCOPE_WRITE_LAYER2,
  submit_bundle: SCOPE_WRITE_LAYER2,
  link_supersedes: SCOPE_WRITE_LAYER2,
  verify_claim: SCOPE_WRITE_LAYER2,
  // ── methodist channel ──
  methodist_diagnose: SCOPE_METHODIST,
  methodist_checkpoint: SCOPE_METHODIST,
  methodist_escalate: SCOPE_METHODIST,
  get_my_development: SCOPE_METHODIST,
  methodist_course: SCOPE_METHODIST,
  // Everything else (all search/find reads, layer2 query/list reads, meta) → SCOPE_READ by default.
};

/** The scope a tool requires (defaults to `read`). */
export function requiredScope(toolName: string): string {
  return TOOL_REQUIRED_SCOPE[toolName] ?? SCOPE_READ;
}

/**
 * Is `toolName` available to a token holding `scopes`? True iff the token holds
 * the tool's required scope. Callers only invoke this when scopes are present;
 * a scope-less (legacy) token is handled by the caller (fall back to legacy gating).
 */
export function toolAllowedByScopes(toolName: string, scopes: readonly string[]): boolean {
  return scopes.includes(requiredScope(toolName));
}
