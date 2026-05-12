import type { McpProfile } from '../types.js';
import { registerSearch } from './search.js';
import { registerGetDocument } from '../shared/get-document.js';
import { registerFindRelated } from '../shared/find-related.js';
import { registerFindCode } from '../shared/find-code.js';
import { registerFindById } from '../shared/find-by-id.js';
import { registerSystemStats } from '../shared/system-stats.js';

const profile: McpProfile = {
  id: 'dev',
  name: 'Development',
  description: 'Sandbox for RAG experiments (RRF, reranking, compression)',
  version: '0.0.1-dev',
  minTokenType: 'consumer',
  registerTools(server, ctx) {
    registerSearch(server, ctx);
    registerGetDocument(server, ctx);
    registerFindRelated(server, ctx);
    registerFindCode(server, ctx);
    registerFindById(server, ctx);
    registerSystemStats(server, ctx);
  },
};

export default profile;
