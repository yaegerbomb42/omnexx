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
    /**
     * Give a stdio server your whole environment. Off by default: it gets only a small base
     * (PATH, HOME, locale, temp and proxy settings) plus what `env` names, so a third-party
     * server never sees every API key in your shell.
     */
    inherit_env: z.boolean().default(false),
    timeout: durationString.default('30s'),
    /** Sign in with OAuth (`omnexx connect <name>`); tokens live in mcp-oauth.json, refreshed as needed. */
    oauth: z.boolean().optional(),
    /** A client id registered ahead of time, for servers without dynamic client registration. */
    oauth_client_id: z.string().optional(),
    /** Space-separated scopes to ask for at sign-in. */
    oauth_scope: z.string().optional(),
    /** `false` keeps the server configured but never started (toggle with `omnexx mcp disable`). */
    enabled: z.boolean().optional(),
  })
  .refine((data) => Boolean(data.command ?? data.url), {
    message: 'Either "command" or "url" must be configured for an MCP server',
  });

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const mcp = z
  .strictObject({
    servers: z.record(z.string(), mcpServerSchema).default({}),
    /**
     * `lazy`: the model sees one small `mcp` tool listing the servers, mounts a server when it needs
     * it and calls its tools through `mcp_call`, so tool schemas never sit in every request.
     * `eager`: every MCP tool is sent on every request (the old behaviour).
     */
    mount: z.enum(['lazy', 'eager']).default('lazy'),
    /** Lazy mounting turns itself off when all MCP tools together cost fewer tokens than this. */
    eager_under_tokens: z.number().int().nonnegative().default(3000),
  })
  .prefault({});

export type McpConfig = z.infer<typeof mcp>;
