import { join } from 'node:path';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { findOtherToolServers, parsePastedServers } from '../integrations/importers.js';
import { installRegistryServer } from '../integrations/install.js';
import { planInstall, searchRegistry } from '../integrations/registry.js';
import { GALLERY } from '../mcp/catalog.js';
import {
  addCommand,
  addFromGallery,
  addUrl,
  configuredServers,
  importServers,
  listServers,
  loginServer,
  removeServer,
  setAllowTools,
  setEnabled,
  type AddResult,
  type McpPlace,
} from '../mcp/manage.js';
import type { CliIO } from './io.js';

/**
 * The `mcp` command of `omnexx chat-server`, for the VS Code MCP section. In: `{type: "mcp", op,
 * …}` with op one of list · gallery · search {query} · add {via, …} · importScan · import {names?,
 * json?} · enable {name, on} · allow {name, tools} · remove {name} · login {name} · logs {name}.
 * Out: mcpServers {servers, checking} · mcpGallery {entries} · mcpRegistry {query, hits} ·
 * mcpImportable {servers} · mcpLogs {name, state, error, log} · mcpResult {ok, message, name?}.
 */

type Command = Record<string, unknown>;
type Write = (msg: object) => void;

export interface McpChatDeps {
  io: CliIO;
  write: Write;
  /** A line in the conversation, so changes are visible in the chat too. */
  note: (text: string) => void;
}

const str = (c: Command, key: string): string => {
  const v = c[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`mcp ${String(c.op)} needs "${key}"`);
  return v.trim();
};

const strings = (v: unknown): Record<string, string> =>
  v && typeof v === 'object'
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      )
    : {};

const place = (io: CliIO): McpPlace => ({ cwd: io.cwd, env: io.env });

/** The list straight from config, then again once every server has been started and counted. */
async function sendList(d: McpChatDeps): Promise<void> {
  d.write({ type: 'mcpServers', servers: await listServers(place(d.io)), checking: true });
  d.write({
    type: 'mcpServers',
    servers: await listServers(place(d.io), { probe: true }),
    checking: false,
  });
}

function summary(r: AddResult): string {
  if (r.needsLogin) return `Added "${r.name}". Sign in to finish (opening your browser).`;
  if (r.probe?.state === 'running') {
    const tools = r.probe.tools.filter((t) => t.allowed);
    const tokens = tools.reduce((s, t) => s + t.tokens, 0);
    return `Added "${r.name}": ${tools.length} tools, ~${tokens} tokens of context.`;
  }
  if (r.probe?.error) return `Added "${r.name}", but it did not start. ${r.probe.error}`;
  return `Added "${r.name}".`;
}

async function login(d: McpChatDeps, name: string): Promise<string> {
  const tools = await loginServer(place(d.io), name, {
    ...(d.io.openUrl ? { open: d.io.openUrl } : {}),
    log: (l) => {
      d.note(l);
    },
  });
  return `Signed in to "${name}": ${tools} tools.`;
}

async function add(d: McpChatDeps, c: Command): Promise<AddResult> {
  const p = place(d.io);
  const via = str(c, 'via');
  const values = strings(c.values);
  if (via === 'gallery')
    return addFromGallery(p, str(c, 'id'), values, {
      ...(typeof c.name === 'string' && c.name.trim() ? { name: c.name.trim() } : {}),
    });
  if (via === 'command') return addCommand(p, str(c, 'name'), str(c, 'command'), values);
  if (via === 'url') return addUrl(p, str(c, 'name'), str(c, 'url'), values);
  if (via === 'registry') {
    const id = str(c, 'id');
    const hit = (await search(d, id)).find((h) => h.name === id);
    const plan = hit && planInstall(hit);
    if (!plan) throw new Error(`${id} has no package or endpoint omnexx can run`);
    const missing = plan.needs.find((n) => n.required && !values[n.key]?.trim());
    if (missing) throw new Error(`${missing.key} is required: ${missing.description}`);
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    const paths = resolvePaths(d.io.env);
    await installRegistryServer(userConfigFile(paths), paths.configHome, plan, given);
    return { name: plan.name, needsLogin: false };
  }
  throw new Error(`unknown way to add a server: "${via}"`);
}

function search(d: McpChatDeps, query: string): ReturnType<typeof searchRegistry> {
  return searchRegistry(query, {
    fetchFn: d.io.fetch ?? fetch,
    cacheFile: join(resolvePaths(d.io.env).configHome, 'cache', 'mcp-registry.json'),
  });
}

/** Do one change, report it, and resend the list. */
async function changed(d: McpChatDeps, message: Promise<string>, name?: string): Promise<void> {
  try {
    const text = await message;
    d.note(text);
    d.write({ type: 'mcpResult', ok: true, message: text, ...(name ? { name } : {}) });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    d.write({ type: 'mcpResult', ok: false, message: text, ...(name ? { name } : {}) });
  }
  await sendList(d);
}

export async function handleMcp(d: McpChatDeps, c: Command): Promise<void> {
  const p = place(d.io);
  switch (c.op) {
    case 'list':
      return sendList(d);
    case 'gallery':
      d.write({ type: 'mcpGallery', entries: GALLERY });
      return;
    case 'search': {
      const query = str(c, 'query');
      const hits = (await search(d, query)).slice(0, 20).flatMap((h) => {
        const plan = planInstall(h);
        return plan
          ? [
              {
                id: h.name,
                name: plan.name,
                title: h.title ?? h.name,
                description: h.description ?? '',
                trusted: h.trusted,
                publisher: h.publisher,
                runs: plan.runs,
                needs: plan.needs,
              },
            ]
          : [];
      });
      d.write({ type: 'mcpRegistry', query, hits });
      return;
    }
    case 'add':
      return changed(
        d,
        add(d, c).then(async (r) => {
          if (!r.needsLogin) return summary(r);
          d.note(summary(r));
          return login(d, r.name);
        }),
      );
    case 'importScan': {
      const have = await configuredServers(p);
      const found = await findOtherToolServers(d.io.env, d.io.cwd);
      d.write({
        type: 'mcpImportable',
        servers: found.map((s) => ({
          name: s.name,
          source: s.source,
          target: s.command ? [s.command, ...s.args].join(' ') : (s.url ?? ''),
          have: s.name in have,
        })),
      });
      return;
    }
    case 'import': {
      const names = Array.isArray(c.names) ? c.names.filter((n) => typeof n === 'string') : [];
      return changed(
        d,
        (async () => {
          const have = await configuredServers(p);
          const found =
            typeof c.json === 'string'
              ? parsePastedServers(c.json)
              : (await findOtherToolServers(d.io.env, d.io.cwd)).filter(
                  (s) => names.includes(s.name) && !(s.name in have),
                );
          if (!found.length) throw new Error('Nothing to import.');
          const added = await importServers(p, found);
          return `Imported ${added.join(', ')}; secrets went to the private secrets file.`;
        })(),
      );
    }
    case 'enable': {
      const name = str(c, 'name');
      const on = c.on === true;
      return changed(
        d,
        setEnabled(p, name, on).then(() => `${on ? 'Enabled' : 'Disabled'} MCP server "${name}".`),
        name,
      );
    }
    case 'allow': {
      const name = str(c, 'name');
      const tools = Array.isArray(c.tools) ? c.tools.filter((t) => typeof t === 'string') : [];
      return changed(
        d,
        setAllowTools(p, name, tools).then(() =>
          tools.length
            ? `"${name}" now offers ${tools.length} tool${tools.length === 1 ? '' : 's'}.`
            : `"${name}" offers all its tools.`,
        ),
        name,
      );
    }
    case 'remove': {
      const name = str(c, 'name');
      return changed(
        d,
        removeServer(p, name).then(() => `Removed MCP server "${name}".`),
        name,
      );
    }
    case 'login': {
      const name = str(c, 'name');
      return changed(d, login(d, name), name);
    }
    case 'logs': {
      const name = str(c, 'name');
      const [v] = await listServers(p, { probe: true, only: name });
      if (!v) throw new Error(`No MCP server called "${name}".`);
      d.write({ type: 'mcpLogs', name, state: v.state, error: v.error ?? null, log: v.log });
      return;
    }
    default:
      throw new Error(`unknown mcp op "${String(c.op)}"`);
  }
}
