/**
 * Generate the v4 researcher role's tools/list DIRECTLY FROM CODE (no live endpoint / token).
 * Runs RESEARCHER.registerTools against a mock server that captures each server.tool(...) call,
 * converts the Zod param shape → JSON Schema (the same conversion the MCP SDK does on tools/list),
 * and prints the tools array. Used to enumerate the flagship methodist-door + Layer-2 traverse
 * tools in the public mcp-server.json (an ops/manifest tool — lives in the excluded scripts dir).
 *
 * buildDoorEngine() runs at registration and constructs the embed/LLM clients (never CALLED here
 * — only the tool schemas are captured), so dummy creds satisfy their constructors:
 *   CORE_INTERNAL_SECRET=x GOOGLE_AI_API_KEY=x QDRANT_URL=http://127.0.0.1:6333 \
 *   NEO4J_URL=bolt://127.0.0.1:7687 NEO4J_USER=x NEO4J_PASSWORD=x \
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/gen-researcher-tools.ts
 *
 * Validated 2026-07-16: 21/22 tools overlapping the live gov tools/list are byte-identical
 * (the lone diff is additionalProperties on the empty-param get_system_stats).
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RESEARCHER } from '../profiles/v4/index.js';

// zod-to-json-schema is a transitive dep (via the MCP SDK), not directly resolvable from @openarx/mcp
// — resolve its version-pinned .pnpm dir at runtime and dynamic-import the ESM entry.
const pnpmRoot = fileURLToPath(new URL('../../../../node_modules/.pnpm/', import.meta.url));
const zjsDir = readdirSync(pnpmRoot).find((d) => d.startsWith('zod-to-json-schema@'));
if (!zjsDir) throw new Error('zod-to-json-schema not found under node_modules/.pnpm');
const { zodToJsonSchema } = (await import(
  `${pnpmRoot}${zjsDir}/node_modules/zod-to-json-schema/dist/esm/index.js`
)) as { zodToJsonSchema: (schema: unknown, opts?: unknown) => Record<string, unknown> };

interface CapturedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

const tools: CapturedTool[] = [];

function toInputSchema(shape: unknown): unknown {
  if (!shape || typeof shape !== 'object') return { type: 'object', properties: {} };
  const zobj =
    '_def' in (shape as Record<string, unknown>)
      ? (shape as z.ZodTypeAny)
      : z.object(shape as z.ZodRawShape);
  // Match the MCP SDK's tools/list conversion exactly (jsonSchema7 + inlined refs + the
  // draft-07 $schema key it emits) so code-generated tools are byte-identical to the live server.
  return zodToJsonSchema(zobj, { target: 'jsonSchema7', $refStrategy: 'none' });
}

// Mock server: capture server.tool(name, description?, shape?, handler) across SDK arities.
const mockServer = {
  tool(name: string, ...rest: unknown[]): void {
    let description: string | undefined;
    let shape: unknown;
    for (const a of rest.slice(0, -1)) {
      if (typeof a === 'string') description = a;
      else if (a && typeof a === 'object') shape = a;
    }
    tools.push({ name, description, inputSchema: toInputSchema(shape) });
  },
  registerTool(name: string, config: Record<string, unknown>, _handler: unknown): void {
    tools.push({
      name,
      description: typeof config?.description === 'string' ? config.description : undefined,
      inputSchema: toInputSchema(config?.inputSchema),
    });
  },
} as unknown;

// ctx is only used inside handlers (called at request time), never at registration — a no-op
// proxy satisfies any incidental access without a real AppContext.
const ctxProxy: unknown = new Proxy(function () {}, {
  get: () => ctxProxy,
  apply: () => ctxProxy,
});

RESEARCHER.registerTools(mockServer as never, ctxProxy as never);

tools.sort((a, b) => a.name.localeCompare(b.name));
process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
