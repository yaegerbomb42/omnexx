import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolvePaths } from '../core/paths.js';
import { parseFrontmatter } from './frontmatter.js';
import { readTextIfExists } from './read.js';

/**
 * Agent cards: named helpers defined in Markdown, the format Claude Code uses for subagents
 * (`.claude/agents/<name>.md`): frontmatter `name`, `description`, optional `tools` and `model`,
 * then the prompt. Omnexx runs them as read-only helpers through the `agent` tool.
 */
export interface AgentCard {
  name: string;
  description: string;
  /** The card's own instructions (the Markdown body). */
  prompt: string;
  /** Tool names the card asks for, as written (`Read, Grep`); empty means the helper default. */
  tools: string[];
  path: string;
  source: 'claude-user' | 'config' | 'user' | 'claude-repo' | 'repo';
}

export interface AgentRoots {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  dirs?: readonly string[];
  importClaude?: boolean;
}

function expandHome(p: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir();
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** Folders cards come from, lowest precedence first (same order as skills). */
export function agentDirs(roots: AgentRoots): { dir: string; source: AgentCard['source'] }[] {
  const env = roots.env ?? process.env;
  const out: { dir: string; source: AgentCard['source'] }[] = [];
  if (roots.importClaude)
    out.push({ dir: expandHome('~/.claude/agents', env), source: 'claude-user' });
  for (const d of roots.dirs ?? []) {
    const dir = expandHome(d, env);
    out.push({
      dir: isAbsolute(dir) || !roots.repoRoot ? dir : join(roots.repoRoot, dir),
      source: 'config',
    });
  }
  out.push({ dir: join(resolvePaths(env).configHome, 'agents'), source: 'user' });
  if (roots.repoRoot !== undefined) {
    if (roots.importClaude)
      out.push({ dir: join(roots.repoRoot, '.claude', 'agents'), source: 'claude-repo' });
    out.push({ dir: join(roots.repoRoot, '.omnexx', 'agents'), source: 'repo' });
  }
  return out;
}

/** `Read, Grep` or `[Read, Grep]` → ['Read', 'Grep']. */
export function parseToolList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,[\]]+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Every card by name, sorted; a later folder shadows a card of the same name. */
export async function listAgentCards(roots: AgentRoots = {}): Promise<AgentCard[]> {
  const byName = new Map<string, AgentCard>();
  for (const { dir, source } of agentDirs(roots)) {
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const path = join(dir, file);
      const text = await readTextIfExists(path);
      if (!text?.trim()) continue;
      const { data, body } = parseFrontmatter(text);
      const front = data.name?.trim() ?? '';
      const name = front.length > 0 ? front : file.slice(0, -3);
      if (!body.trim()) continue;
      byName.set(name, {
        name,
        description: data.description?.trim() ?? '',
        prompt: body.trim(),
        tools: parseToolList(data.tools),
        path,
        source,
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
