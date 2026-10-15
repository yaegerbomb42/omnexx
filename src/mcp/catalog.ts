import { CONNECTORS, type Connector } from '../integrations/connectors.js';
import { SECRET_PREFIX } from '../integrations/secrets.js';

/**
 * Popular MCP servers for one-click setup (the VS Code gallery, `omnexx mcp add <id>`): the
 * developer staples below plus the app connectors (`omnexx connect`). Everything here is free to
 * run; remote `oauth` entries sign in through the browser.
 */

export interface GalleryNeed {
  key: string;
  /** What to enter and where to get it. */
  help: string;
  /** "env": a variable for a local server; "header": an HTTP header; "arg": fills `{KEY}` in args. */
  target: 'env' | 'header' | 'arg';
  /** Masked, stored in the 0600 secrets file. Args are never secret (they sit in config.toml). */
  secret: boolean;
  required: boolean;
  /** A bare token typed for an Authorization header gets "Bearer " in front. */
  bearer?: boolean;
  placeholder?: string;
}

export interface GalleryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  command?: string;
  args?: readonly string[];
  url?: string;
  oauth: boolean;
  needs: readonly GalleryNeed[];
  /** Setup steps or caveats, shown before adding. */
  note?: string;
}

const arg = (key: string, help: string, placeholder: string): GalleryNeed => ({
  key,
  help,
  target: 'arg',
  secret: false,
  required: true,
  placeholder,
});

const DEV_SERVERS: readonly GalleryEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write and search files in folders you choose',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{FOLDER}'],
    oauth: false,
    needs: [arg('FOLDER', 'the folder it may use', '/path/to/folder')],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a real browser: navigate, click, fill forms, screenshot',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    oauth: false,
    needs: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch web pages and turn them into markdown',
    category: 'dev',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    oauth: false,
    needs: [],
    note: 'Needs uv (https://docs.astral.sh/uv/) for uvx.',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A persistent knowledge graph the agent can remember things in',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    oauth: false,
    needs: [],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Step-by-step structured reasoning scratchpad',
    category: 'dev',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    oauth: false,
    needs: [],
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date library docs and code examples',
    category: 'dev',
    url: 'https://mcp.context7.com/mcp',
    oauth: false,
    needs: [
      {
        key: 'CONTEXT7_API_KEY',
        help: 'optional API key for higher limits: https://context7.com/dashboard',
        target: 'header',
        secret: true,
        required: false,
      },
    ],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Inspect schemas and run read-only SQL',
    category: 'data',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '{DATABASE_URL}'],
    oauth: false,
    needs: [arg('DATABASE_URL', 'the connection URL', 'postgresql://localhost/mydb')],
    note: 'The connection URL is saved in config.toml; prefer a read-only user.',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and explore a SQLite database file',
    category: 'data',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '{DB_PATH}'],
    oauth: false,
    needs: [arg('DB_PATH', 'the database file', '/path/to/app.db')],
    note: 'Needs uv (https://docs.astral.sh/uv/) for uvx.',
  },
];

function fromConnector(c: Connector): GalleryEntry {
  return {
    id: c.id,
    name: c.name,
    description: c.how ?? (c.auth === 'oauth' ? 'Sign in with your browser' : c.category),
    category: c.category,
    ...(c.command ? { command: c.command, args: c.args ?? [] } : {}),
    ...(c.url ? { url: c.url } : {}),
    oauth: c.auth === 'oauth',
    needs: (c.needs ?? []).map((n) => ({
      key: n.key,
      help: n.help,
      target: n.target,
      secret: !n.visible,
      required: true,
      ...(n.bearer ? { bearer: true } : {}),
    })),
    ...(c.note ? { note: c.note } : {}),
  };
}

/** Connectors that need a guided flow (questions, a check, the omnexx binary) stay in `connect`. */
const simpleConnector = (c: Connector): boolean =>
  !c.verify && !c.questions?.length && c.command !== 'omnexx' && !c.env;

export const GALLERY: readonly GalleryEntry[] = [
  ...DEV_SERVERS,
  ...CONNECTORS.filter(simpleConnector).map(fromConnector),
];

export const findGalleryEntry = (id: string): GalleryEntry | undefined =>
  GALLERY.find((g) => g.id === id.toLowerCase());

/** The values that go to the secrets file, and the args with `{KEY}` filled in. */
export interface GalleryInstall {
  table: {
    command?: string;
    args?: readonly string[];
    url?: string;
    env?: Record<string, string>;
    headers_env?: Record<string, string>;
    oauth?: boolean;
  };
  secrets: Record<string, string>;
}

/**
 * Turn a gallery entry and what the person entered into a server table and its secrets. Throws
 * naming the first required value that is missing.
 */
export function planGalleryInstall(
  entry: GalleryEntry,
  values: Readonly<Record<string, string>>,
): GalleryInstall {
  const given: Record<string, string> = {};
  for (const n of entry.needs) {
    let v = values[n.key]?.trim() ?? '';
    if (!v) {
      if (n.required) throw new Error(`${entry.name} needs ${n.key}: ${n.help}`);
      continue;
    }
    if (n.bearer && !/\s/.test(v)) v = `Bearer ${v}`;
    given[n.key] = v;
  }
  const kept = (target: GalleryNeed['target']) =>
    entry.needs.filter((n) => n.target === target && given[n.key] !== undefined);
  const refs = (target: GalleryNeed['target']) =>
    Object.fromEntries(kept(target).map((n) => [n.key, `${SECRET_PREFIX}${n.key}`]));
  const args = entry.args?.map((a) =>
    a.replace(/\{([A-Z0-9_]+)\}/g, (m, k: string) => given[k] ?? m),
  );
  const env = refs('env');
  const headers = refs('header');
  const secrets = Object.fromEntries(
    [...kept('env'), ...kept('header')].map((n) => [n.key, given[n.key] ?? '']),
  );
  return {
    table: {
      ...(entry.command ? { command: entry.command, args: args ?? [] } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(Object.keys(headers).length ? { headers_env: headers } : {}),
      ...(entry.oauth ? { oauth: true } : {}),
    },
    secrets,
  };
}
