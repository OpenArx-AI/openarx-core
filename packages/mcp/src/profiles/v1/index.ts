import type { McpProfile } from '../types.js';
import { registerSearchSuite } from '../shared/search-suite.js';
import { registerMethodistTools } from '../methodist-tools.js';

const profile: McpProfile = {
  id: 'v1',
  name: 'Stable',
  description: 'Superseded by the `researcher` profile (mcp_profiles_v3.md) — kept as a compatibility facade, still fully functional. Hybrid search v2: differentiated tools (search / search_keyword / search_semantic) with chunk-context filters and detail levels.',
  version: '2.0.0',
  minTokenType: 'consumer',
  registerTools(server, ctx) {
    registerSearchSuite(server, ctx);
    // §4 unified facade: methodist tools are visible here too, but scope-gated —
    // invisible unless the token carries `methodist` (fail-closed in the gateway).
    registerMethodistTools(server, ctx);
  },
};

export default profile;
