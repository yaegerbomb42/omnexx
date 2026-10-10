import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { selfEntry } from '../../daemon/detach.js';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { mcpServerSchema } from '../../config/sections/mcp.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import {
  CONNECTORS,
  connectorServer,
  findConnector,
  type Connector,
} from '../../integrations/connectors.js';
import { readConfigText, tomlFor, writeServer } from '../../integrations/install.js';
import { readSecrets, writeServerSecrets } from '../../integrations/secrets.js';
import { removeTable } from '../../integrations/toml-edit.js';
import { signIn } from '../../mcp/login.js';
import { forgetLogin, hasTokens } from '../../mcp/oauth.js';
import { EXIT } from '../exit-codes.js';
import { confirm, println, readLine, readSecret, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const HOW: Record<Connector['auth'], string> = {
  oauth: 'browser sign-in',
  token: 'token',
  none: 'no setup',
};

/** `KEY=VALUE` flags into a record. */
function presets(set: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    set.flatMap((kv) => {
      const i = kv.indexOf('=');
      return i > 0 ? [[kv.slice(0, i), kv.slice(i + 1)]] : [];
    }),
  );
}

/** The values a connector needs: from --set, else asked for (passwords hidden). */
async function collect(
  io: CliIO,
  c: Connector,
  preset: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const out: Record<string, string> = {};
  for (const n of c.needs ?? []) {
    const help = n.helpFor?.(out) ?? n.help;
    let v = preset[n.key];
    if (v === undefined && io.isTTY) {
      const prompt = `${n.key} (${help}): `;
      v = n.visible ? await readLine(io, prompt) : await readSecret(io, prompt);
    }
    v = v?.trim();
    if (!v) {
      println(io.stderr, `${n.key} is needed: ${help}. Pass it with --set ${n.key}=…`);
      return undefined;
    }
    out[n.key] = n.bearer && !/\s/.test(v) ? `Bearer ${v}` : v;
  }
  for (const key of c.optional ?? []) if (preset[key]) out[key] = preset[key];
  for (const q of c.questions ?? []) {
    const yes =
      preset[q.key] !== undefined
        ? preset[q.key] === '1'
        : io.isTTY && (await confirm(io, q.question));
    if (yes) out[q.key] = '1';
  }
  return out;
}

/** `omnexx` on the PATH, else this very install (e.g. run through npx). */
async function withSelfCommand<T extends { command?: string; args?: readonly string[] }>(
  io: CliIO,
  table: T,
): Promise<T> {
  if (table.command !== 'omnexx') return table;
  const found = await Promise.any(
    (io.env.PATH ?? '').split(delimiter).map((dir) => access(join(dir, 'omnexx'), constants.X_OK)),
  ).then(
    () => true,
    () => false,
  );
  if (found) return table;
  const [node = 'node', ...entry] = io.entry ?? selfEntry();
  return { ...table, command: node, args: [...entry, ...(table.args ?? [])] };
}

async function listCatalog(io: CliIO): Promise<void> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const home = resolvePaths(io.env).configHome;
  const configured = new Set(Object.keys(config.mcp.servers));
  const signedIn = new Set(
    (
      await Promise.all(
        CONNECTORS.filter((c) => c.auth === 'oauth').map(async (c) =>
          (await hasTokens(home, c.id)) ? c.id : '',
        ),
      )
    ).filter(Boolean),
  );
  let category = '';
  for (const c of CONNECTORS) {
    if (c.category !== category) {
      category = c.category;
      println(io.stdout, `\n${category}`);
    }
    const on = configured.has(c.id) && (c.auth !== 'oauth' || signedIn.has(c.id));
    println(
      io.stdout,
      `  ${on ? '✓' : ' '} ${c.id.padEnd(16)} ${c.name}  (${c.how ?? HOW[c.auth]})`,
    );
  }
  println(io.stdout, '\nConnect one: omnexx connect <name>. Anything else: omnexx mcp add <name>.');
}

async function connect(io: CliIO, c: Connector, preset: Record<string, string>): Promise<number> {
  const paths = resolvePaths(io.env);
  if (c.note) println(io.stdout, c.note);
  const values = await collect(io, c, preset);
  if (!values) return EXIT.error;
  if (c.verify) {
    println(io.stdout, 'Checking the sign-in…');
    const problem = await c.verify(values);
    if (problem) {
      println(io.stderr, `Not connected: ${problem}`);
      return EXIT.error;
    }
  }
  if (Object.keys(values).length) await writeServerSecrets(paths.configHome, c.id, values);
  const table = await withSelfCommand(io, connectorServer(c, Object.keys(values)));
  await writeServer(userConfigFile(paths), c.id, tomlFor(table));
  if (c.auth !== 'oauth') {
    println(io.stdout, `Connected ${c.name}. Check it with: omnexx mcp test ${c.id}`);
    return EXIT.ok;
  }
  const server = mcpServerSchema.parse(table);
  const secrets = (await readSecrets(paths.configHome))[c.id] ?? {};
  const tools = await signIn(c.id, server, {
    configHome: paths.configHome,
    secrets,
    ...(io.openUrl ? { open: io.openUrl } : {}),
    log: (l) => {
      println(io.stdout, l);
    },
  });
  println(io.stdout, `Connected ${c.name}: ${tools} tool(s) available to omnexx.`);
  return EXIT.ok;
}

async function disconnect(io: CliIO, id: string): Promise<boolean> {
  const paths = resolvePaths(io.env);
  const file = userConfigFile(paths);
  const { text, removed } = removeTable(await readConfigText(file), ['mcp', 'servers', id]);
  if (removed) await writeFile(file, text, 'utf8');
  await writeServerSecrets(paths.configHome, id, {});
  await forgetLogin(paths.configHome, id);
  return removed;
}

export const register: CommandRegistrar = (program: Command, io: CliIO, setExit) => {
  program
    .command('connect [name]')
    .description('connect an app (Gmail, Slack, Notion, Linear, GitHub, …); no name lists them')
    .option('--set <KEY=VALUE...>', 'a token or setting the connector needs', [])
    .action(async (name: string | undefined, opts: { set: string[] }) => {
      if (!name) {
        await listCatalog(io);
        return;
      }
      const c = findConnector(name);
      if (!c) {
        println(
          io.stderr,
          `No connector "${name}". \`omnexx connect\` lists them; \`omnexx mcp add ${name}\` searches the MCP registry.`,
        );
        setExit(EXIT.error);
        return;
      }
      try {
        setExit(await connect(io, c, presets(opts.set)));
      } catch (err) {
        println(io.stderr, `Could not connect ${c.name}: ${errText(err)}`);
        setExit(EXIT.error);
      }
    });

  program
    .command('serve-email', { hidden: true })
    .description('the email MCP server over stdio (started by the email connector)')
    .action(async () => {
      const { serveEmail } = await import('../../integrations/email/server.js');
      await serveEmail(io.env);
    });

  program
    .command('disconnect <name>')
    .description('remove a connected app and forget its sign-in and tokens')
    .action(async (name: string) => {
      const removed = await disconnect(io, name.toLowerCase());
      println(
        io.stdout,
        removed
          ? `Disconnected ${name}.`
          : `${name} was not connected; cleared any stored sign-in.`,
      );
    });
};
