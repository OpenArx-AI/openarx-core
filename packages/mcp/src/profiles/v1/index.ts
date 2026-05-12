import type { McpProfile } from '../types.js';
import { registerSearchSuite } from '../shared/search-suite.js';

const profile: McpProfile = {
  id: 'v1',
  name: 'Stable',
  description: 'Hybrid search v2: differentiated tools (search / search_keyword / search_semantic) with chunk-context filters and detail levels',
  version: '2.0.0',
  minTokenType: 'consumer',
  registerTools(server, ctx) {
    registerSearchSuite(server, ctx);
  },
};

export default profile;
