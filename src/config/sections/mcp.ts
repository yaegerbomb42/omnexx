import { z } from 'zod';
import { durationString } from '../duration.js';

/**
 * [mcp.servers.<name>] config.
 * Supports either:
 * - stdio: command + optional args + env (list of env var names to forward from host, or record)
 * - http / sse: url + optional headers_env (record of header names to env var names)
 */
export const mcpServerSchema = z
  .strictObject({
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    /** List of env-var NAMES to forward from process.env (not raw values), or map of key -> env var name */
    env: z.union([z.array(z.string()), z.record(z.string(), z.string())]).default([]),
    url: z.url().optional(),
    headers_env: z.record(z.string(), z.string()).default({}),
    allow_tools: z.array(z.string()).default(['*']),
    timeout: durationString.default('30s'),
  })
  .refine((data) => Boolean(data.command ?? data.url), {
    message: 'Either "command" or "url" must be configured for an MCP server',
  });

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const mcp = z
  .strictObject({
    servers: z.record(z.string(), mcpServerSchema).default({}),
  })
  .prefault({});

export type McpConfig = z.infer<typeof mcp>;
