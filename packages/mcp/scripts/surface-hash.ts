#!/usr/bin/env tsx
/**
 * Surface Area Hash — detects silent schema changes in MCP tools.
 *
 * For each profile, instantiates McpServer, registers tools, extracts
 * tool definitions, and computes SHA256(name + description + JSON(inputSchema)).
 *
 * Output: JSON map { "profile/tool_name": "<sha256>" }
 *
 * Usage:
 *   pnpm --filter @openarx/mcp surface-hash
 *   # Outputs to stdout. Redirect to surface-area.json and commit.
 */

import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllProfiles } from '../src/profiles/registry.js';

// Stub context — we only need tool registration, not actual DB access
const stubCtx = {
  documentStore: {},
  vectorStore: {},
  searchStore: {},
  geminiEmbedder: {},
  embedClient: {},
  pool: { query: async () => ({ rows: [] }) },
  shutdown: async () => {},
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

async function main(): Promise<void> {
  const result: Record<string, string> = {};

  for (const profile of getAllProfiles()) {
    const server = new McpServer({
      name: `openarx-${profile.id}`,
      version: profile.version,
    });

    profile.registerTools(server, stubCtx);

    // Access registered tools via the server's internal state
    // McpServer exposes tools through listTools after connection,
    // but we can access the registered tool map directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverAny = server as any;
    const toolMap: Map<string, { description?: string; inputSchema?: unknown }> =
      serverAny._registeredTools ?? serverAny.registeredTools ?? new Map();

    for (const [name, tool] of toolMap) {
      const def: ToolDef = {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      const payload = def.name + (def.description ?? '') + JSON.stringify(def.inputSchema ?? {});
      const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
      result[`${profile.id}/${name}`] = hash;
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
