import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../core/atomic.js';
import type { McpConfig } from '../config/sections/mcp.js';
import type { McpToolInfo } from './client-manager.js';
import { formatMcpToolName, normalizeMcpSchema } from './normalizer.js';
import { toolTokens } from './status.js';

/**
 * Lazy MCP mounting. Instead of every server's tool schemas riding in every request, the model
 * gets a fixed pair of tools: `mcp` (lists servers; mounting one returns its schemas as a tool
 * result) and `mcp_call` (calls a mounted server's tool, args validated against its schema).
 *
 * The tool list never changes when a server is mounted, so the cached prompt prefix (tools, then
 * system, then history) stays byte-identical on Anthropic and OpenAI-compatible providers alike;
 * the schemas arrive in the conversation tail, which is cached from then on like any other turn.
 */

/** The run-store file listing the servers this run or chat has mounted. */
export const MOUNTED_FILE = 'mcp-mounted.json';

/** Tool names shown per server in the `mcp` directory before eliding the rest. */
const DIRECTORY_TOOL_NAMES = 6;

/** Tokens every exposed MCP tool definition would cost in each request, schemas included. */
export function mcpToolTokens(tools: readonly McpToolInfo[]): number {
  return tools.reduce(
    (sum, t) =>
      sum +
      toolTokens({
        name: formatMcpToolName(t.serverName, t.name),
        description: t.description,
        inputSchema: normalizeMcpSchema(t.inputSchema),
      }),
    0,
  );
}

/** Lazy unless configured eager, or everything together is cheap enough to just send. */
export function mountsLazily(
  config: Pick<McpConfig, 'mount' | 'eager_under_tokens'>,
  tools: readonly McpToolInfo[],
): boolean {
  return config.mount === 'lazy' && mcpToolTokens(tools) >= config.eager_under_tokens;
}

export function toolsByServer(tools: readonly McpToolInfo[]): ReadonlyMap<string, McpToolInfo[]> {
  const out = new Map<string, McpToolInfo[]>();
  for (const t of tools) out.set(t.serverName, [...(out.get(t.serverName) ?? []), t]);
  return out;
}

/** One line per server: name, tool count and the first few tool names. Sorted for a stable prefix. */
export function serverDirectory(byServer: ReadonlyMap<string, McpToolInfo[]>): string {
  return [...byServer.keys()]
    .sort()
    .map((server) => {
      const tools = byServer.get(server) ?? [];
      const names = tools.slice(0, DIRECTORY_TOOL_NAMES).map((t) => t.name);
      const more = tools.length > DIRECTORY_TOOL_NAMES ? ', …' : '';
      return `- ${server} (${tools.length} tools): ${names.join(', ')}${more}`;
    })
    .join('\n');
}

/** What mounting a server hands the model: each tool's name, description and input schema. */
export function renderSchemas(server: string, tools: readonly McpToolInfo[]): string {
  const specs = tools.map((t) => ({
    tool: t.name,
    description: t.description,
    schema: normalizeMcpSchema(t.inputSchema),
  }));
  return `Mounted "${server}". Call these with mcp_call({server: "${server}", tool, args}).\n${JSON.stringify(specs)}`;
}

export async function readMounted(path: string): Promise<readonly string[]> {
  try {
    const value = await readJson(path);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return []; // not mounted anything yet
  }
}

/** Records a mounted server; returns the new list. */
export async function addMounted(path: string, server: string): Promise<readonly string[]> {
  const current = await readMounted(path);
  if (current.includes(server)) return current;
  const next = [...current, server].sort();
  await writeJsonAtomic(path, next);
  return next;
}

/** Why `args` do not fit the tool's JSON schema, or undefined when they do (or it can't be checked). */
export function argsProblem(inputSchema: unknown, args: unknown): string | undefined {
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(normalizeMcpSchema(inputSchema));
  } catch {
    return undefined; // a schema zod can't read: let the server judge the args
  }
  const res = schema.safeParse(args);
  if (res.success) return undefined;
  return res.error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(args)'}: ${i.message}`)
    .join('; ');
}
