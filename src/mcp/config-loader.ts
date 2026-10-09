import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpConfig, McpServerConfig } from '../config/sections/mcp.js';

/** Schema for .mcp.json (Claude Code / MCP config format) */
const mcpJsonServerSchema = z.strictObject({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allow_tools: z.array(z.string()).optional(),
  timeout: z.string().optional(),
});

const mcpJsonSchema = z.object({
  mcpServers: z.record(z.string(), mcpJsonServerSchema).optional(),
});

/**
 * Loads .mcp.json from the repository root if present.
 * Translates env keys into array/record for McpServerConfig.
 */
export async function loadRepoMcpJson(repoRoot: string): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await readFile(join(repoRoot, '.mcp.json'), 'utf8');
    const parsed = mcpJsonSchema.parse(JSON.parse(raw));
    if (!parsed.mcpServers) return {};

    const result: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      if (!server.command && !server.url) continue;

      result[name] = {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? [],
        url: server.url,
        headers_env: server.headers ?? {},
        allow_tools: server.allow_tools ?? ['*'],
        inherit_env: false,
        timeout: server.timeout ?? '30s',
      };
    }
    return result;
  } catch {
    // Non-existent or invalid .mcp.json is ignored
    return {};
  }
}

/**
 * Merges repo .mcp.json servers with user/omnexx config.
 * User config in `config.mcp.servers` wins over repo `.mcp.json`.
 */
export async function resolveMcpServers(
  repoRoot: string,
  mcpConfig?: McpConfig,
): Promise<Record<string, McpServerConfig>> {
  const repoServers = await loadRepoMcpJson(repoRoot);
  const configServers = mcpConfig?.servers ?? {};
  return {
    ...repoServers,
    ...configServers,
  };
}
