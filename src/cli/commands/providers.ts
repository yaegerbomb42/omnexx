import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { stringify as stringifyToml } from 'smol-toml';
import { findProviderKey } from '../../auth/keys.js';
import { loadConfig } from '../../config/load.js';
import { parseDuration } from '../../config/duration.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { UsageError } from '../../errors.js';
import {
  endpointAuth,
  kindForFlavor,
  PROVIDER_CATALOG,
  type CatalogEntry,
} from '../../providers/catalog.js';
import { makeEndpointProvider } from '../../providers/make.js';
import type { EndpointConfig } from '../../config/schema.js';
import type { EndpointAuth } from '../../providers/auth-headers.js';
import type { CommandRegistrar } from './extra/types.js';
import type { SmartAddOptions } from './providers-add.js';
import { println, readLine, type CliIO } from '../io.js';
import { EXIT } from '../exit-codes.js';

type EndpointKind = EndpointConfig['kind'];

/** Preset templates: suggestions only, written into user config on `add`. */
export interface ProviderTemplate {
  baseUrl: string;
  keyEnv: string | undefined;
  free: boolean;
  kind: EndpointKind;
  /** How the key is sent; unset is a bearer token. */
  auth?: EndpointAuth;
  /** Extra headers sent with every request (never secrets: they are written to config). */
  headers?: Record<string, string>;
  /** Display name. */
  label?: string;
  /** How its API keys start, so a pasted key is recognised. */
  keyPrefix?: string;
  /** Where to get a key. */
  signup?: string;
  /** Local server: no key, started by the person. */
  local?: boolean;
}

/**
 * Presets derived from the provider catalog (src/providers/catalog.ts): every entry whose base
 * URL needs no extra values. Anthropic is built in and templated entries (Azure, Bedrock, Vertex,
 * Cloudflare) go through the settings form or `omnexx providers add <id> --field k=v`.
 */
export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = Object.fromEntries([
  ...PROVIDER_CATALOG.filter((e) => e.id !== 'anthropic' && e.fields.length === 0).map(
    (e): [string, ProviderTemplate] => [e.id, templateFromEntry(e, e.baseUrl)],
  ),
  [
    'custom',
    { baseUrl: 'http://localhost:8000/v1', keyEnv: undefined, free: false, kind: 'openai' },
  ],
]);

/** A config template for a catalog entry at a (filled-in) base URL. */
export function templateFromEntry(e: CatalogEntry, baseUrl: string): ProviderTemplate {
  const auth = endpointAuth(e.auth);
  return {
    label: e.name,
    baseUrl,
    keyEnv: e.keyEnvs[0],
    free: e.local,
    kind: kindForFlavor(e.flavor),
    ...(auth ? { auth } : {}),
    ...(e.keyPrefix ? { keyPrefix: e.keyPrefix } : {}),
    ...(e.signup ? { signup: e.signup } : {}),
    ...(e.local ? { local: true } : {}),
  };
}

export function templateFor(name: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES[name.toLowerCase()];
}

/** Commander collector for repeatable options. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export async function appendEndpointBlock(
  file: string,
  name: string,
  t: ProviderTemplate,
): Promise<void> {
  const block = stringifyToml({
    providers: {
      endpoints: {
        [name]: {
          kind: t.kind,
          base_url: t.baseUrl,
          ...(t.keyEnv ? { api_key_env: t.keyEnv } : {}),
          ...(t.auth ? { auth: t.auth } : {}),
          ...(t.headers && Object.keys(t.headers).length ? { headers: t.headers } : {}),
          ...(t.free ? { free: true } : {}),
        },
      },
    },
  });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `\n${block}`);
}

export async function removeEndpointBlock(file: string, name: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[providers.endpoints.${name}]`);
  if (start === -1) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  await mkdir(dirname(file), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, lines.slice(0, start).concat(lines.slice(end)).join('\n'));
  return true;
}

async function testEndpoint(
  io: CliIO,
  name: string,
  baseUrl: string,
  apiKey: string | undefined,
  kind: EndpointKind,
  extra: { auth?: EndpointAuth | undefined; headers?: Record<string, string> | undefined } = {},
): Promise<{ ok: boolean; detail: string }> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const ep = config.providers.endpoints[name];
  const timeoutMs = ep ? parseDuration(ep.request_timeout) : 10_000;
  const opts = {
    name,
    baseUrl,
    apiKey,
    timeoutMs,
    ...(extra.auth ? { auth: extra.auth } : {}),
    ...(extra.headers ? { headers: extra.headers } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
  const provider = makeEndpointProvider(kind, opts);
  try {
    // 1-token test call: tiny maxTokens, no tools.
    const res = await provider.complete({
      model: 'test',
      system: [{ text: 'Reply with the single word: ok' }],
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
      maxTokens: 1,
      messageBreakpoints: [],
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .slice(0, 80);
    return { ok: true, detail: text ? `answered (${text})` : 'answered' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProvidersAddOptions {
  baseUrl?: string | undefined;
  keyEnv?: string | undefined;
  free?: boolean | undefined;
  kind?: 'openai' | 'responses' | undefined;
  skipTest?: boolean | undefined;
}

export async function providersAdd(
  io: CliIO,
  name: string,
  opts: ProvidersAddOptions,
): Promise<number> {
  const lower = name.toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(lower))
    throw new UsageError(`bad provider name "${name}"`, 'use lowercase letters, digits, _ or -');
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  if (config.providers.endpoints[lower])
    throw new UsageError(
      `provider "${lower}" already exists`,
      `use \`omnexx providers remove ${lower}\` first`,
    );
  const template = templateFor(lower);
  let baseUrl = opts.baseUrl;
  let keyEnv = opts.keyEnv;
  let free = opts.free;
  const kind = opts.kind ?? template?.kind ?? 'openai';
  if (baseUrl === undefined || keyEnv === undefined) {
    if (io.isTTY && process.env.VITEST === undefined) {
      // Interactive prompts (readline, no new deps).
      println(io.stdout, `Adding provider "${lower}"${template ? ` (template: ${lower})` : ''}.`);
      const askBase = await readLine(
        io,
        `Base URL [${template?.baseUrl ?? 'http://localhost:8000/v1'}]: `,
      );
      baseUrl = baseUrl ?? askBase?.trim() ?? template?.baseUrl ?? 'http://localhost:8000/v1';
      const askKey = await readLine(io, `Key env var [${template?.keyEnv ?? 'none'}]: `);
      const trimmedKey = (keyEnv ?? askKey?.trim() ?? template?.keyEnv ?? '').trim();
      keyEnv = trimmedKey ? trimmedKey : undefined;
      if (free === undefined) {
        const askFree = await readLine(io, 'Free / no key needed? [y/N]: ');
        const saidYes = /^\s*y(es)?\s*$/i.test(askFree ?? '');
        const templateFree = keyEnv === undefined && template?.free === true;
        free = saidYes || templateFree;
      }
    } else {
      baseUrl ??= template?.baseUrl;
      keyEnv ??= template?.keyEnv;
      free ??= template?.free ?? false;
      if (!baseUrl)
        throw new UsageError('missing --base-url', 'pass --base-url or use a known template name');
    }
  }
  free = free ?? false;
  const file = userConfigFile(resolvePaths(io.env));
  await appendEndpointBlock(file, lower, { baseUrl, keyEnv, free, kind });
  println(io.stdout, `Added [providers.endpoints.${lower}] to ${file}.`);
  if (!opts.skipTest) {
    const paths = resolvePaths(io.env);
    const key = await findProviderKey(paths, io.env, lower, keyEnv);
    const t = await testEndpoint(io, lower, baseUrl, key?.key, kind);
    println(io.stdout, t.ok ? `Test call ok: ${t.detail}` : `Test call failed: ${t.detail}`);
    if (!t.ok) return EXIT.error;
  }
  return EXIT.ok;
}

export async function providersList(io: CliIO): Promise<number> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  println(io.stdout, 'anthropic (built-in)');
  for (const [name, ep] of Object.entries(config.providers.endpoints)) {
    println(io.stdout, `${name}  ${ep.base_url}${ep.free ? '  (free)' : ''}`);
  }
  return EXIT.ok;
}

export async function providersRemove(io: CliIO, name: string): Promise<number> {
  const lower = name.toLowerCase();
  if (lower === 'anthropic') throw new UsageError('cannot remove anthropic', 'it is built in');
  const file = userConfigFile(resolvePaths(io.env));
  const removed = await removeEndpointBlock(file, lower);
  println(
    io.stdout,
    removed
      ? `Removed [providers.endpoints.${lower}] from ${file}.`
      : `No [providers.endpoints.${lower}] in ${file}.`,
  );
  return EXIT.ok;
}

export async function providersTest(io: CliIO, name: string): Promise<number> {
  const lower = name.toLowerCase();
  if (lower === 'anthropic')
    throw new UsageError('anthropic has no test yet', 'run `omnexx doctor` to check the key');
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const ep = config.providers.endpoints[lower];
  if (!ep)
    throw new UsageError(
      `unknown provider "${lower}"`,
      '`omnexx providers list` shows configured providers',
    );
  const key = await findProviderKey(resolvePaths(io.env), io.env, lower, ep.api_key_env);
  const t = await testEndpoint(io, lower, ep.base_url, key?.key, ep.kind, {
    auth: ep.auth,
    headers: ep.headers,
  });
  println(io.stdout, t.ok ? `ok: ${t.detail}` : `failed: ${t.detail}`);
  return t.ok ? EXIT.ok : EXIT.error;
}

export const register: CommandRegistrar = (
  program: Command,
  io: CliIO,
  setExit: (c: number) => void,
) => {
  const p = program.command('providers').description('add, list, remove and test model providers');
  p.command('add [name]')
    .description('add a provider (interactive, or flags)')
    .option('--base-url <url>', 'endpoint base URL')
    .option('--key-env <var>', 'env var holding the key')
    .option('--free', 'no key needed (local models)')
    .option('--kind <kind>', 'openai|responses')
    .option('--no-test', 'skip the 1-token test call')
    .option('--key <key>', 'API key (stored 0600; probes the endpoint and detects its API)')
    .option('--field <name=value>', 'a value the base URL needs, e.g. resource=my-azure', collect)
    .option('--header <name:value>', 'an extra request header', collect)
    .option('--flavor <flavor>', 'openai-chat|openai-responses|anthropic|gemini (default: detect)')
    .action(
      async (
        name: string | undefined,
        opts: {
          baseUrl?: string;
          keyEnv?: string;
          free?: boolean;
          kind?: string;
          test?: boolean;
        } & SmartAddOptions,
      ) => {
        const n = name ?? 'custom';
        // Loaded lazily: providers-add → provider-setup → connect imports this module.
        const smart = await import('./providers-add.js');
        if (smart.wantsSmartAdd(n, opts) || (n === 'custom' && !opts.baseUrl && io.isTTY)) {
          setExit(await smart.providersAddSmart(io, n, opts));
          return;
        }
        const kind = opts.kind === 'responses' ? 'responses' : 'openai';
        setExit(
          await providersAdd(io, n, {
            baseUrl: opts.baseUrl,
            keyEnv: opts.keyEnv,
            free: opts.free,
            kind,
            skipTest: opts.test === false,
          }),
        );
      },
    );
  p.command('catalog')
    .description('every provider omnexx knows by name')
    .action(async () => {
      setExit((await import('./providers-add.js')).providersCatalog(io));
    });
  p.command('list')
    .description('list configured providers')
    .action(async () => {
      setExit(await providersList(io));
    });
  p.command('remove <name>')
    .description('remove a provider from user config')
    .action(async (name: string) => {
      setExit(await providersRemove(io, name));
    });
  p.command('test <name>')
    .description('run a 1-token test call')
    .action(async (name: string) => {
      setExit(await providersTest(io, name));
    });
};
