import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { stringify as stringifyToml } from 'smol-toml';
import { findProviderKey } from '../../auth/keys.js';
import { loadConfig } from '../../config/load.js';
import { parseDuration } from '../../config/duration.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { UsageError } from '../../errors.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { ResponsesProvider } from '../../providers/responses.js';
import type { CommandRegistrar } from './extra/types.js';
import { println, readLine, type CliIO } from '../io.js';
import { EXIT } from '../exit-codes.js';

/** Preset templates: suggestions only, written into user config on `add`. */
export interface ProviderTemplate {
  baseUrl: string;
  keyEnv: string | undefined;
  free: boolean;
  kind: 'openai' | 'responses';
}

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    free: false,
    kind: 'openai',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    free: false,
    kind: 'openai',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    free: false,
    kind: 'openai',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    free: false,
    kind: 'openai',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: 'TOGETHER_API_KEY',
    free: false,
    kind: 'openai',
  },
  fireworks: {
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnv: 'FIREWORKS_API_KEY',
    free: false,
    kind: 'openai',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    free: false,
    kind: 'openai',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyEnv: 'GEMINI_API_KEY',
    free: false,
    kind: 'openai',
  },
  xai: { baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', free: false, kind: 'openai' },
  ollama: { baseUrl: 'http://localhost:11434/v1', keyEnv: undefined, free: true, kind: 'openai' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', keyEnv: undefined, free: true, kind: 'openai' },
  vllm: { baseUrl: 'http://localhost:8000/v1', keyEnv: undefined, free: true, kind: 'openai' },
  litellm: { baseUrl: 'http://localhost:4000/v1', keyEnv: undefined, free: true, kind: 'openai' },
  custom: { baseUrl: 'http://localhost:8000/v1', keyEnv: undefined, free: false, kind: 'openai' },
};

export function templateFor(name: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES[name.toLowerCase()];
}

async function appendEndpointBlock(file: string, name: string, t: ProviderTemplate): Promise<void> {
  const block = stringifyToml({
    providers: {
      endpoints: {
        [name]: {
          kind: t.kind,
          base_url: t.baseUrl,
          ...(t.keyEnv ? { api_key_env: t.keyEnv } : {}),
          ...(t.free ? { free: true } : {}),
        },
      },
    },
  });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `\n${block}`);
}

async function removeEndpointBlock(file: string, name: string): Promise<boolean> {
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
  kind: 'openai' | 'responses',
): Promise<{ ok: boolean; detail: string }> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const ep = config.providers.endpoints[name];
  const timeoutMs = ep ? parseDuration(ep.request_timeout) : 10_000;
  const provider =
    kind === 'responses'
      ? new ResponsesProvider({
          name,
          baseUrl,
          apiKey,
          timeoutMs,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        })
      : new OpenAICompatProvider({
          name,
          baseUrl,
          apiKey,
          timeoutMs,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
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
  const t = await testEndpoint(
    io,
    lower,
    ep.base_url,
    key?.key,
    (ep as { kind?: 'openai' | 'responses' }).kind ?? 'openai',
  );
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
    .action(
      async (
        name: string | undefined,
        opts: { baseUrl?: string; keyEnv?: string; free?: boolean; kind?: string; test?: boolean },
      ) => {
        const n = name ?? 'custom';
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
