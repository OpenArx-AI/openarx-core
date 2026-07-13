// ── v4 role: researcher (F2.7) ───────────────────────────────────────────────
//
// "One scientist's pass" — ALL working tools (§1): Layer-1 document search + read,
// Layer-2 scientific graph read (get/find/search/explore_topic), document
// publication, and the methodist door group (§3). Everything except governance.
//
// NOT on the surface: direct graph-write tools (§3 — Layer-2 writes are a
// methodist-mediated / internal-primitive consequence of checkpoint, not an agent
// tool; F2.4). No scope filtering (§2 — everything here is visible to any researcher).

import { registerSearchSuite } from '../shared/search-suite.js';
import { registerPublishTools } from '../pub/publish-tools.js';
import { registerScientificReads, registerMethodistDoors } from '../methodist-v2/index.js';
import type { V4Role } from './types.js';

export const RESEARCHER: V4Role = {
  token_type: 'researcher',
  name: 'Researcher',
  version: '4.0.0',
  registerTools(server, ctx) {
    registerSearchSuite(server, ctx); // Layer-1 document search + read
    registerScientificReads(server, ctx); // Layer-2 graph read: get / find / search / explore_topic
    registerPublishTools(server, ctx); // document publication (Layer 1)
    registerMethodistDoors(server, ctx); // methodist door group (§3) — by role, no scope
  },
};
