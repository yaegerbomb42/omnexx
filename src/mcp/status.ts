import type { McpServerConfig } from '../config/sections/mcp.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * What a configured MCP server is doing, for `omnexx mcp list`, the TUI's `/mcp` and the VS Code
 * MCP section: running with its tools (each tool's schema costs context tokens on every request),
 * failed with why, or switched off.
 */

export type ServerState = 'running' | 'failed' | 'disabled' | 'unchecked';

export interface ProbedTool {
  name: string;
  description: string;
  /** Approximate tokens its name, description and schema take in every request. */
  tokens: number;
  /** False when the server's `allow_tools` leaves it out: it is never shown to the model. */
  allowed: boolean;
}

export interface ServerProbe {
  name: string;
  state: 'running' | 'failed';
  tools: ProbedTool[];
  error?: string;
  /** The server's stderr tail (stdio servers). */
  log: string;
}

/** Lines of stderr shown in a start-failure message (the Logs view has the rest). */
const ERROR_TAIL_LINES = 12;

/** Tokens one tool definition costs: what the model is sent for it. */
export function toolTokens(t: {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}): number {
  return estimateTokens(
    JSON.stringify({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema }),
  );
}

const INSTALL_HINTS: Record<string, string> = {
  npx: 'npx comes with Node.js: install it from https://nodejs.org',
  node: 'install Node.js from https://nodejs.org',
  uvx: 'uvx comes with uv: install it from https://docs.astral.sh/uv/',
  uv: 'install uv from https://docs.astral.sh/uv/',
  docker: 'install Docker Desktop and start it',
  python: 'install Python 3',
  python3: 'install Python 3',
};

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The last few non-empty lines of a log. */
export function tail(log: string, lines = ERROR_TAIL_LINES): string {
  return log
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

/**
 * Why a server didn't start, in words a person can act on: a missing command, a sign-in it
 * needs, a refused connection, or the server's own error output.
 */
export function describeStartFailure(
  name: string,
  config: McpServerConfig,
  err: unknown,
  log: string,
): string {
  const msg = errMessage(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  let reason: string;
  if (code === 'ENOENT' || /\bENOENT\b/.test(msg)) {
    const cmd = config.command ?? '';
    reason = `"${cmd}" was not found on PATH${INSTALL_HINTS[cmd] ? ` (${INSTALL_HINTS[cmd]})` : ''}`;
  } else if (code === 401 || /unauthori[sz]ed|\b401\b/i.test(msg)) {
    reason = `it needs you to sign in: omnexx mcp login ${name}`;
  } else if (code === 403 || /\b403\b|forbidden/i.test(msg)) {
    reason = 'it refused the credentials (403): check the token';
  } else if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
    reason = `could not reach ${config.url ?? 'it'} (${msg})`;
  } else if (/timed? ?out/i.test(msg)) {
    reason = `it did not answer within ${config.timeout} (raise \`timeout\` if it is just slow to install)`;
  } else if (/\b(404|405)\b/.test(msg) && /\/sse\/?$/.test(config.url ?? '')) {
    reason = `${msg}. This looks like an old SSE-only endpoint; omnexx speaks streamable HTTP (try the server's /mcp URL)`;
  } else if (/connection closed/i.test(msg)) {
    reason = 'it exited during startup';
  } else reason = msg;
  const out = tail(log);
  return `MCP server "${name}" failed to start: ${reason}${out ? `\n--- its output ---\n${out}` : ''}`;
}
