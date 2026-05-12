import type { McpProfile } from '../types.js';
import { registerSearchSuite } from '../shared/search-suite.js';
import { registerPublishTools } from '../pub/publish-tools.js';
import { registerGovernanceTools } from './tools.js';

const profile: McpProfile = {
  id: 'gov',
  name: 'Governance',
  description: 'Search v2 (15 tools) + publishing + governance participation for AI agents',
  version: '0.5.0',
  minTokenType: 'gov_participant',
  registerTools(server, ctx) {
    // Inherit full v2 search suite (matches v1 profile)
    registerSearchSuite(server, ctx);
    // Inherit publisher tools
    registerPublishTools(server, ctx);
    // Governance proxy to Gov API
    registerGovernanceTools(server);
  },
};

export default profile;
