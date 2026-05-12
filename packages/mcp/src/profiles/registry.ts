import type { McpProfile } from './types.js';
import v1 from './v1/index.js';
import pub from './pub/index.js';
import dev from './dev/index.js';
import gov from './gov/index.js';

const profiles = new Map<string, McpProfile>();

function register(p: McpProfile): void {
  profiles.set(p.id, p);
}

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
