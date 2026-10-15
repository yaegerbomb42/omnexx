import { z } from 'zod';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { McpCallResult, McpClientManager, McpToolInfo } from '../../mcp/client-manager.js';
import {
  MOUNTED_FILE,
  addMounted,
  argsProblem,
  readMounted,
  renderSchemas,
  serverDirectory,
  toolsByServer,
} from '../../mcp/mount.js';
import { normalizeMcpSchema, trimMcpOutput } from '../../mcp/normalizer.js';

/** An MCP result as tool output: text parts joined, images dropped, redacted and capped. */
export function formatResult(result: McpCallResult, ctx: ToolContext): ToolOutput {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === 'text' && item.text) {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push('[Image data dropped]');
    }
  }
  const trimmed = trimMcpOutput(ctx.redactor.text(parts.join('\n')));
  return result.isError ? fail(trimmed) : ok(trimmed);
}

const mountSchema = z.strictObject({
  server: z.string().describe('Name of the MCP server to mount'),
});

const callSchema = z.strictObject({
  server: z.string().describe('A mounted MCP server'),
  tool: z.string().describe("The tool's name as listed when the server was mounted"),
  args: z.record(z.string(), z.unknown()).default({}).describe('Arguments matching its schema'),
});

const mountedPath = (ctx: ToolContext): string => ctx.store.file(MOUNTED_FILE);

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function createMountTool(byServer: ReadonlyMap<string, McpToolInfo[]>): Tool<typeof mountSchema> {
  return {
    name: 'mcp',
    description:
      'Mount an installed MCP server to use its tools. Returns their names and input schemas; ' +
      'then call them with mcp_call. A server stays mounted for the whole session (mount it ' +
      'again to see its schemas again). Installed servers:\n' +
      serverDirectory(byServer),
    schema: mountSchema,
    readOnly: false,
    async run(input, ctx) {
      const tools = byServer.get(input.server);
      if (!tools) {
        const installed = [...byServer.keys()].sort().join(', ');
        return fail(`No MCP server "${input.server}". Installed: ${installed}`);
      }
      try {
        await addMounted(mountedPath(ctx), input.server);
      } catch (err) {
        return fail(`Could not record the mount: ${ctx.redactor.text(errText(err))}`);
      }
      return ok(ctx.redactor.text(renderSchemas(input.server, tools)));
    },
  };
}

function createCallTool(
  manager: McpClientManager,
  byServer: ReadonlyMap<string, McpToolInfo[]>,
): Tool<typeof callSchema> {
  return {
    name: 'mcp_call',
    description: 'Call a tool of an MCP server mounted with the mcp tool.',
    schema: callSchema,
    readOnly: false,
    async run(input, ctx) {
      const { server, tool, args } = input;
      if (!(await readMounted(mountedPath(ctx))).includes(server)) {
        return fail(
          `MCP server "${server}" is not mounted: call mcp({server: "${server}"}) first.`,
        );
      }
      const target = byServer.get(server)?.find((t) => t.name === tool);
      if (!target) {
        return fail(`MCP server "${server}" has no tool "${tool}". Mount it again to list them.`);
      }
      const problem = argsProblem(target.inputSchema, args);
      if (problem) {
        const schema = JSON.stringify(normalizeMcpSchema(target.inputSchema));
        return fail(`Invalid args for ${server}/${tool}: ${problem}\nSchema: ${schema}`);
      }
      try {
        return formatResult(await manager.callTool(server, tool, args), ctx);
      } catch (err) {
        return fail(`MCP call error: ${ctx.redactor.text(errText(err))}`);
      }
    },
  };
}

/** The two fixed tools lazy mode exposes, whatever is mounted: the cached prefix never moves. */
export function lazyMcpTools(manager: McpClientManager, allTools: readonly McpToolInfo[]): Tool[] {
  const byServer = toolsByServer(allTools);
  return [createMountTool(byServer), createCallTool(manager, byServer)] as Tool[];
}
