import type { McpProfile } from '../types.js';
import { registerSearchSuite } from '../shared/search-suite.js';
import { registerPublishTools } from './publish-tools.js';
import { registerMethodistTools } from '../methodist-tools.js';

const profile: McpProfile = {
  id: 'pub',
  name: 'Publisher',
  description: 'Superseded by the `researcher` profile (mcp_profiles_v3.md) — kept as a compatibility facade, still fully functional. Search v2 (15 tools) + document publishing and management.',
  version: '0.2.0',
  minTokenType: 'publisher',
  registerTools(server, ctx) {
    // Inherit full v2 search suite (matches v1 profile)
    registerSearchSuite(server, ctx);
    // Publisher-specific tools
    registerPublishTools(server, ctx);
    // §4 unified facade: methodist tools scope-gated (invisible without `methodist`).
    registerMethodistTools(server, ctx);
  },
};

export default profile;
