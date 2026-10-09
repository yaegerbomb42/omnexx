import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { mcpServerSchema } from '../../config/sections/mcp.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import {
  CONNECTORS,
  connectorServer,
  findConnector,
  type Connector,
  type ConnectorNeed,
} from '../../integrations/connectors.js';
import { readConfigText, tomlFor, writeServer } from '../../integrations/install.js';
import { readSecrets, writeServerSecrets } from '../../integrations/secrets.js';
import { removeTable } from '../../integrations/toml-edit.js';
import { signIn } from '../../mcp/login.js';
import { forgetLogin, hasTokens } from '../../mcp/oauth.js';
import { EXIT } from '../exit-codes.js';
import { println, readSecret, type CliIO } from '../io.js';
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

/** The values a connector needs: from --set, else asked for (hidden input). */
async function collect(
  io: CliIO,
  needs: readonly ConnectorNeed[],
  preset: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const out: Record<string, string> = {};
  for (const n of needs) {
    let v = preset[n.key];
    if (v === undefined && io.isTTY) v = await readSecret(io, `${n.key} (${n.help}): `);
    v = v?.trim();
    if (!v) {
      println(io.stderr, `${n.key} is needed: ${n.help}. Pass it with --set ${n.key}=…`);
      return undefined;
    }
    out[n.key] = n.bearer && !/\s/.test(v) ? `Bearer ${v}` : v;
  }
  return out;
}

async function listCatalog(io: CliIO): Promise<void> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const home = resolvePaths(io.env).configHome;
  const configured = new Set(Object.keys(config.mcp.servers));
  let category = '';
  for (const c of CONNECTORS) {
    if (c.category !== category) {
      category = c.category;
      println(io.stdout, `\n${category}`);
    }
    const on = configured.has(c.id) && (c.auth !== 'oauth' || (await hasTokens(home, c.id)));
    println(io.stdout, `  ${on ? '✓' : ' '} ${c.id.padEnd(16)} ${c.name}  (${HOW[c.auth]})`);
  }
  println(io.stdout, '\nConnect one: omnexx connect <name>. Anything else: omnexx mcp add <name>.');
}

async function connect(io: CliIO, c: Connector, preset: Record<string, string>): Promise<number> {
  const paths = resolvePaths(io.env);
  if (c.note) println(io.stdout, c.note);
  const values = await collect(io, c.needs ?? [], preset);
  if (!values) return EXIT.error;
  if (Object.keys(values).length) await writeServerSecrets(paths.configHome, c.id, values);
  const table = connectorServer(c);
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
