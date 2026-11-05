import { z } from 'zod';
import type { McpClientManager, McpToolInfo } from '../../mcp/client-manager.js';
import { formatMcpToolName } from '../../mcp/normalizer.js';
import { formatResult } from '../../tools/extra/mcp-lazy.js';
import { fail, type Tool } from '../../tools/types.js';
import { loadSkill } from '../../instructions/skills.js';
import type { SkillRoots } from '../../instructions/skills.js';

/**
 * Runtime bridge so the kernel can lazy-connect MCP servers and page skill bodies
 * when a catalog capability is mounted into the active set.
 */
export interface CapabilityRuntime {
  /** Connect `serverName`, list tools, return Omnexx Tool wrappers. */
  loadMcpServerTools(serverName: string): Promise<readonly Tool[]>;
  /** Load a skill body for context paging (undefined if missing). */
  loadSkillBody?(name: string): Promise<string | undefined>;
  /** Whether this runtime can serve the given MCP server name. */
  hasMcpServer?(serverName: string): boolean;
}

/** Build direct `mcp__server__tool` Tools from listed MCP tool infos. */
export function toolsFromMcpInfos(
  manager: McpClientManager,
  infos: readonly McpToolInfo[],
): Tool[] {
  const looseSchema = z.record(z.string(), z.unknown());
  return infos.map((toolInfo) => {
    const directName = formatMcpToolName(toolInfo.serverName, toolInfo.name);
    const serverName = toolInfo.serverName;
    const toolName = toolInfo.name;
    return {
      name: directName,
      description: toolInfo.description || `MCP tool ${toolName} from server ${serverName}`,
      schema: looseSchema,
      readOnly: false,
      async run(input, ctx) {
        try {
          const args = (input ?? {}) as Record<string, unknown>;
          const res = await manager.callTool(serverName, toolName, args);
          return formatResult(res, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`MCP call error: ${ctx.redactor.text(msg)}`);
        }
      },
    } satisfies Tool;
  });
}

/** CapabilityRuntime backed by an McpClientManager (+ optional skill roots). */
export function mcpCapabilityRuntime(
  manager: McpClientManager,
  skillRoots?: SkillRoots,
): CapabilityRuntime {
  return {
    hasMcpServer: (name) => manager.hasServer(name),
    async loadMcpServerTools(serverName) {
      const infos = await manager.listServerTools(serverName);
      return toolsFromMcpInfos(manager, infos);
    },
    async loadSkillBody(name) {
      const skill = await loadSkill(name, skillRoots ?? {});
      if (!skill) return undefined;
      return `# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}`;
    },
  };
}

/** Extract MCP server key from a catalog id like `local:mcp:fake` or `registry:mcp:owner/pkg`. */
export function mcpServerKeyFromCatalogId(id: string, serverField?: string): string | undefined {
  if (serverField?.trim()) return serverField.trim();
  if (id.startsWith('local:mcp:')) return id.slice('local:mcp:'.length);
  if (id.startsWith('registry:mcp:')) return id.slice('registry:mcp:'.length);
  return undefined;
}

export function skillNameFromCatalogId(id: string, nameField?: string): string | undefined {
  if (nameField?.trim()) return nameField.trim();
  if (id.startsWith('local:skill:')) return id.slice('local:skill:'.length);
  if (id.startsWith('registry:skill:')) {
    const slug = id.slice('registry:skill:'.length);
    return slug.includes('/') ? slug.split('/').pop() : slug;
  }
  return undefined;
}
