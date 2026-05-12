import type { McpProfile } from '../types.js';
import { registerSearchSuite } from '../shared/search-suite.js';
import { registerPublishTools } from './publish-tools.js';

const profile: McpProfile = {
  id: 'pub',
  name: 'Publisher',
  description: 'Search v2 (15 tools) + document publishing and management',
  version: '0.2.0',
  minTokenType: 'publisher',
  registerTools(server, ctx) {
    // Inherit full v2 search suite (matches v1 profile)
    registerSearchSuite(server, ctx);
    // Publisher-specific tools
    registerPublishTools(server, ctx);
  },
};

export default profile;
