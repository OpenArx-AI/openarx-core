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

// Server-level MCP `instructions` — an EAGER cold-start signal. Claude-Code-family harnesses
// surface a server's instructions in the system prompt even when tools are DEFERRED (names-only),
// so the methodist door is discoverable before the agent reads any tool description (the
// description-only "START HERE" hook is invisible under deferral — methodist CS1/CS2). Conditional
// ("IF … conduct or contribute research") so pure search/read agents aren't nudged. Methodology
// content = methodist SoT (mirror-pattern; keep in sync with their door-guidance source).
const RESEARCHER_INSTRUCTIONS =
  'OpenArx is AI-native infrastructure for scientific knowledge. IF your task is to conduct or ' +
  'contribute research — survey a field, verify a claim, synthesize, map a dispute, set an agenda, ' +
  'or engineer a solution — do not just search-and-summarize: START with the `methodist` tool. It ' +
  "is the platform's methodological guide — it diagnoses your task into the right research cycle, " +
  'hands you the method one stage at a time, gates quality (GO/RETURN), and records your findings ' +
  'as provenance-tracked, reusable claims in the knowledge graph. The search/retrieval tools ' +
  'gather evidence WITHIN that method. Begin research by opening `methodist` with your research ' +
  'question as its intent.';

export const RESEARCHER: V4Role = {
  token_type: 'researcher',
  name: 'Researcher',
  version: '4.0.0',
  instructions: RESEARCHER_INSTRUCTIONS,
  registerTools(server, ctx) {
    registerSearchSuite(server, ctx); // Layer-1 document search + read
    registerScientificReads(server, ctx); // Layer-2 graph read: get / find / search / explore_topic
    registerPublishTools(server, ctx); // document publication (Layer 1)
    registerMethodistDoors(server, ctx); // methodist door group (§3) — by role, no scope
  },
};
