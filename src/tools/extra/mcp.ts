import { z } from 'zod';
import type { ToolSource, ToolWhere } from './types.js';
import { resolvePaths } from '../../core/paths.js';
import { readSecrets } from '../../integrations/secrets.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { OmnexxConfig } from '../../config/schema.js';
import { resolveMcpServers } from '../../mcp/config-loader.js';
import { McpClientManager, type McpToolInfo } from '../../mcp/client-manager.js';
import { formatMcpToolName, normalizeMcpSchema, trimMcpOutput } from '../../mcp/normalizer.js';

let activeManager: McpClientManager | null = null;

export function getActiveMcpManager(): McpClientManager | null {
  return activeManager;
}

export async function resetMcpManager(): Promise<void> {
  if (activeManager) {
    await activeManager.closeAll();
    activeManager = null;
  }
}

function formatResult(
  result: {
    content: {
      type: string;
      text?: string | undefined;
      data?: string | undefined;
      mimeType?: string | undefined;
    }[];
    isError?: boolean | undefined;
  },
  ctx: ToolContext,
): ToolOutput {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === 'text' && item.text) {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push('[Image data dropped]');
    }
  }
  const joined = parts.join('\n');
  const redacted = ctx.redactor.text(joined);
  const trimmed = trimMcpOutput(redacted);
  return result.isError ? fail(trimmed) : ok(trimmed);
}

const searchSchema = z.strictObject({
  query: z.string().describe('Search query to find relevant MCP tools by name or description'),
});

const callSchema = z.strictObject({
  tool: z.string().describe('Full name of the MCP tool to call, e.g. mcp__server__tool_name'),
  args: z.record(z.string(), z.unknown()).default({}).describe('Arguments for the MCP tool'),
});

function createSearchTool(allTools: McpToolInfo[]): Tool<typeof searchSchema> {
  return {
    name: 'mcp_search',
    description:
      'Search available Model Context Protocol (MCP) tools by keyword when tool count exceeds 20. Returns tool names, descriptions, and input schemas.',
    schema: searchSchema,
    readOnly: true,
    run(input, ctx) {
      const q = input.query.toLowerCase();
      const matched = allTools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.serverName.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
      const summary = matched.map((t) => ({
        fullName: formatMcpToolName(t.serverName, t.name),
        description: t.description,
        schema: normalizeMcpSchema(t.inputSchema),
      }));
      return Promise.resolve(ok(ctx.redactor.text(JSON.stringify(summary, null, 2))));
    },
  };
}

function createCallTool(
  manager: McpClientManager,
  allTools: McpToolInfo[],
): Tool<typeof callSchema> {
  const toolMap = new Map<string, McpToolInfo>();
  for (const t of allTools) {
    toolMap.set(formatMcpToolName(t.serverName, t.name), t);
  }

  return {
    name: 'mcp_call',
    description:
      'Call an MCP tool discovered via mcp_search by supplying its full name and arguments.',
    schema: callSchema,
    readOnly: false,
    async run(input, ctx) {
      const target = toolMap.get(input.tool);
      if (!target) {
        return fail(`MCP tool "${input.tool}" not found. Use mcp_search to find available tools.`);
      }
      try {
        const res = await manager.callTool(target.serverName, target.name, input.args);
        return formatResult(res, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`MCP call error: ${ctx.redactor.text(msg)}`);
      }
    },
  };
}

function createDirectTool(
  manager: McpClientManager,
  serverName: string,
  toolInfo: McpToolInfo,
): Tool {
  const directName = formatMcpToolName(serverName, toolInfo.name);
  const looseSchema = z.record(z.string(), z.unknown());

  return {
    name: directName,
    description: toolInfo.description || `MCP tool ${toolInfo.name} from server ${serverName}`,
    schema: looseSchema,
    readOnly: false,
    async run(input, ctx) {
      try {
        const args = (input ?? {}) as Record<string, unknown>;
        const res = await manager.callTool(serverName, toolInfo.name, args);
        return formatResult(res, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`MCP call error: ${ctx.redactor.text(msg)}`);
      }
    },
  };
}

export const source: ToolSource = {
  async load(config: OmnexxConfig, where?: ToolWhere): Promise<readonly Tool[]> {
    const env = where?.env ?? process.env;
    const serverConfigs = await resolveMcpServers(where?.repoRoot ?? process.cwd(), config.mcp);
    if (Object.keys(serverConfigs).length === 0) {
      return [];
    }

    activeManager ??= new McpClientManager(serverConfigs, {
      env,
      secrets: await readSecrets(resolvePaths(env).configHome),
      configHome: resolvePaths(env).configHome,
    });
    const mgr = activeManager;

    const allTools = await mgr.listTools();
    if (allTools.length === 0) {
      return [];
    }

    // If more than 20 MCP tools total, expose a single mcp_search + mcp_call
    if (allTools.length > 20) {
      return [createSearchTool(allTools), createCallTool(mgr, allTools)];
    }

    // Otherwise expose individual tools as mcp__<server>__<tool>
    return allTools.map((t) => createDirectTool(mgr, t.serverName, t));
  },
};
