// ── Profile: researcher (mcp_profiles_v3.md §2) ──────────────────────────────
//
// The single role-based scientific-work profile: search-and-read + document
// publishing + the full Layer 2 claims/relations graph (+ methodist reserve, §13,
// wired once the A5 handlers land). "One scientist's pass", not three passes
// (library / print-shop / registry).
//
// Access differentiation is by TOKEN SCOPE, not by profile — read-only is a token
// without write scopes on THIS SAME profile. The gateway filters the tool list by
// scope (see index.ts server.tool wrapper + profiles/scopes.ts): read tools always
// show; write:documents / write:layer2 / methodist tools show only when the token
// holds that scope. Endpoint: /researcher/mcp.
//
// v1 / pub / layer2 remain as compatibility facades (superseded-not-deleted, §4):
// their tool lists are UNCHANGED; researcher is the new canonical role surface.

import type { McpProfile } from '../types.js';
import { registerSearchSuite } from '../shared/search-suite.js';
import { registerPublishTools } from '../pub/publish-tools.js';
import { registerMethodistTools } from '../methodist-tools.js';

const profile: McpProfile = {
  id: 'researcher',
  name: 'Researcher',
  description:
    "The scientist's pass — search + read, document publishing, and the methodist channel in one role profile. Access is by token scope (read-only = a token without write scopes): write:documents, methodist. Supersedes the v1/pub split, which remain as compatibility facades (≥90-day alias window). (Layer 2 claims/relations moved to the methodist checkpoint + read surface — MASTER_CONTRACT §11.2.)",
  version: '0.3.0',
  // Access is by scope, not token type: a consumer token reaches the read surface;
  // write tools are gated by scope in the gateway. minTokenType stays at the floor.
  minTokenType: 'consumer',
  registerTools(server, ctx) {
    registerSearchSuite(server, ctx); // search + read (find/search umbrellas added in the consolidation step)
    registerPublishTools(server, ctx); // document writes — scope write:documents
    // Layer 2 PG write/read tools (submit_*/query_*/verify_claim/link_supersedes) REMOVED with
    // the PG-graph teardown (openarx-1woy): writes → the methodist checkpoint door (§12.3),
    // graph reads → the consolidated read surface / methodist read-doors (§12.5). MASTER_CONTRACT
    // §11.2 v4 target + §0-bis supersede-banner already codify this.
    registerMethodistTools(server, ctx); // methodist channel — scope methodist (§13)
  },
};

export default profile;
