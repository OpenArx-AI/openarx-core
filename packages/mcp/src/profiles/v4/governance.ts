// ── v4 role: governance (F2.7) ───────────────────────────────────────────────
//
// The separate civic pass (§1): membership / voting / governance surface, plus the
// read surface (a governance participant reads the corpus to deliberate). Distinct
// nature — membership-gated, different token lifecycle. No methodist doors, no
// document publication (those are the researcher pass).

import { registerSearchSuite } from '../shared/search-suite.js';
import { registerGovernanceTools } from '../gov/tools.js';
import type { V4Role } from './types.js';

export const GOVERNANCE: V4Role = {
  token_type: 'governance',
  name: 'Governance',
  version: '4.0.0',
  registerTools(server, ctx) {
    registerSearchSuite(server, ctx); // read the corpus to deliberate / vote
    registerGovernanceTools(server); // membership / voting / governance
  },
};
