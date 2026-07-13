import type { McpProfile } from './types.js';
import v1 from './v1/index.js';
import pub from './pub/index.js';
import dev from './dev/index.js';
import gov from './gov/index.js';
import researcher from './researcher/index.js';

const profiles = new Map<string, McpProfile>();

function register(p: McpProfile): void {
  profiles.set(p.id, p);
}

// researcher = the canonical v3 role profile (mcp_profiles_v3.md). v1/pub are kept
// as compatibility facades — superseded-not-deleted (§4): broken links are worse than
// stale ones. The layer2 facade (/layer2/mcp) was UNMOUNTED with the PG-graph teardown
// (openarx-1woy): its tools all operated on dropped PG tables (500s); getProfile('layer2')
// now returns undefined → 404, matching the v4 target (MASTER_CONTRACT §11.2).
register(researcher);
register(v1);
register(pub);
register(dev);
register(gov);

export function getProfile(id: string): McpProfile | undefined {
  return profiles.get(id);
}

export function getAllProfiles(): McpProfile[] {
  return [...profiles.values()];
}
