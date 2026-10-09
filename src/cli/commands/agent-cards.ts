import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { listAgentCards, type AgentRoots } from '../../instructions/agents.js';
import { fetchCard } from '../../integrations/a2a.js';
import { readConfigText } from '../../integrations/install.js';
import { SECRET_PREFIX, writeServerSecrets } from '../../integrations/secrets.js';
import { removeTable, setTable } from '../../integrations/toml-edit.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

const SOURCE_LABEL = {
  'claude-user': 'Claude Code',
  config: '[agents] dirs',
  user: 'omnexx user',
  'claude-repo': 'repo .claude',
  repo: 'repo .omnexx',
} as const;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const register: CommandRegistrar = (program: Command, io: CliIO, setExit) => {
  const cmd = program
    .command('agent-cards')
    .description('Agents omnexx can hand work to: local cards (Markdown) and remote A2A agents');
  const configFile = () => userConfigFile(resolvePaths(io.env));

  async function roots(): Promise<{ roots: AgentRoots; remote: Record<string, { url: string }> }> {
    const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
    return {
      roots: {
        repoRoot: io.cwd,
        env: io.env,
        dirs: config.agents.dirs,
        importClaude: config.agents.import_claude,
      },
      remote: config.agents.remote,
    };
  }

  cmd
    .command('list')
    .description('every agent card, where it comes from, and the remote agents')
    .action(async () => {
      const { roots: r, remote } = await roots();
      const cards = await listAgentCards(r);
      for (const c of cards)
        println(
          io.stdout,
          `${c.name.padEnd(24)} ${SOURCE_LABEL[c.source].padEnd(14)} ${c.description.replace(/\s+/g, ' ').slice(0, 80)}`,
        );
      for (const [name, a] of Object.entries(remote))
        println(io.stdout, `${name.padEnd(24)} ${'remote (A2A)'.padEnd(14)} ${a.url}`);
      if (!cards.length && !Object.keys(remote).length)
        println(
          io.stdout,
          'No agents yet. Write one as .omnexx/agents/<name>.md, or add a remote one: omnexx agent-cards add <url>',
        );
    });

  cmd
    .command('add <url>')
    .description('add a remote A2A agent by its URL (reads its agent card)')
    .option('--name <name>', 'what to call it (default: from its card)')
    .option(
      '--header <K=V...>',
      'a header to send, e.g. Authorization=Bearer … (stored as a secret)',
      [],
    )
    .action(async (url: string, opts: { name?: string; header: string[] }) => {
      try {
        const headers = Object.fromEntries(
          opts.header.flatMap((h) => {
            const at = h.indexOf('=');
            return at > 0 ? [[h.slice(0, at), h.slice(at + 1)]] : [];
          }),
        );
        const card = await fetchCard(url, io.fetch ?? fetch, headers);
        const name = (opts.name ?? card.name).replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase();
        const file = configFile();
        const next = setTable(await readConfigText(file), ['agents', 'remote', name], {
          url,
          headers_env: Object.keys(headers).length
            ? Object.fromEntries(Object.keys(headers).map((k) => [k, `${SECRET_PREFIX}${k}`]))
            : undefined,
        });
        await writeFile(file, next, 'utf8');
        if (Object.keys(headers).length)
          await writeServerSecrets(resolvePaths(io.env).configHome, `agent:${name}`, headers);
        println(io.stdout, `Added the remote agent "${name}": ${card.description.slice(0, 120)}`);
        if (card.skills.length) println(io.stdout, `  skills: ${card.skills.join(', ')}`);
      } catch (err) {
        println(io.stderr, `Could not add the agent: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  cmd
    .command('remove <name>')
    .description('remove a remote agent (local cards are files: delete the file)')
    .action(async (name: string) => {
      const file = configFile();
      const { text, removed } = removeTable(await readConfigText(file), ['agents', 'remote', name]);
      if (!removed) {
        println(io.stderr, `No remote agent "${name}" in ${file}.`);
        setExit(EXIT.error);
        return;
      }
      await writeFile(file, text, 'utf8');
      await writeServerSecrets(resolvePaths(io.env).configHome, `agent:${name}`, {});
      println(io.stdout, `Removed ${name}.`);
    });

  cmd
    .command('import')
    .description("use Claude Code's agents (read in place, so they stay in sync)")
    .action(async () => {
      const { roots: r } = await roots();
      if (!r.importClaude) {
        println(
          io.stdout,
          'Claude Code agents are off. Turn them on with [agents] import_claude = true.',
        );
        return;
      }
      const claude = (await listAgentCards(r)).filter((c) => c.source.startsWith('claude'));
      println(
        io.stdout,
        claude.length
          ? `Using ${claude.length} Claude Code agent${claude.length === 1 ? '' : 's'}: ${claude.map((c) => c.name).join(', ')}`
          : 'No Claude Code agents found in ~/.claude/agents or .claude/agents.',
      );
    });
};
