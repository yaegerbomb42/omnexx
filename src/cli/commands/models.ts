import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { findProviderKey } from '../../auth/keys.js';
import { loadConfig } from '../../config/load.js';
import { parseDuration } from '../../config/duration.js';
import {
  loadModelProfiles,
  type ModelProfileInput,
} from '../../config/sections/models-profiles.js';
import { resolvePaths, userConfigFile } from '../../core/paths.js';
import { UsageError } from '../../errors.js';
import { discoverModels } from '../../providers/discovery.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { ResponsesProvider } from '../../providers/responses.js';
import { GeminiProvider } from '../../providers/gemini.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import type { CompletionRequest } from '../../providers/types.js';
import type { CommandRegistrar } from './extra/types.js';
import { println, type CliIO } from '../io.js';
import { EXIT } from '../exit-codes.js';

function splitRef(ref: string): { provider: string; model: string } {
  const cut = ref.indexOf(':');
  if (cut <= 0 || cut === ref.length - 1)
    throw new UsageError(`bad model ref "${ref}"`, 'expected "<provider>:<model>"');
  return { provider: ref.slice(0, cut).toLowerCase(), model: ref.slice(cut + 1) };
}

function parseCtx(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(value.trim());
  if (!m) throw new UsageError(`bad --ctx "${value}"`, 'use a number like 200000 or 200k');
  const n = Number(m[1]);
  const mult = m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.floor(n * mult);
}

async function readUserToml(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

function profileBlock(ref: string, p: ModelProfileInput): string {
  return stringifyToml({ models: { profiles: { [ref]: { ...p } } } });
}

async function removeProfileBlock(file: string, ref: string): Promise<boolean> {
  const text = await readUserToml(file);
  if (!text) return false;
  const lines = text.split('\n');
  const header = `[models.profiles.${JSON.stringify(ref)}]`;
  const alt = `[models.profiles."${ref}"]`;
  const start = lines.findIndex((l) => {
    const t = l.trim();
    return t === header || t === alt || t === `[models.profiles.'${ref}']`;
  });
  if (start === -1) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.slice(0, start).concat(lines.slice(end)).join('\n'));
  return true;
}

export interface ModelsAddOptions {
  tags?: string | undefined;
  ctx?: string | undefined;
  vision?: boolean | undefined;
  tools?: boolean | undefined;
  speed?: 'fast' | 'normal' | 'slow' | undefined;
  quality?: 'low' | 'mid' | 'high' | undefined;
}

export async function modelsAdd(io: CliIO, ref: string, opts: ModelsAddOptions): Promise<number> {
  const { provider } = splitRef(ref);
  const fullRef = `${provider}:${ref.slice(ref.indexOf(':') + 1)}`;
  const ctx = parseCtx(opts.ctx);
  const profile: ModelProfileInput = {
    tags: opts.tags
      ? opts.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    ...(ctx !== undefined ? { context: ctx } : {}),
    tools: opts.tools ?? true,
    vision: opts.vision ?? false,
    speed: opts.speed ?? 'normal',
    quality: opts.quality ?? 'mid',
  };
  const file = userConfigFile(resolvePaths(io.env));
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `\n${profileBlock(fullRef, profile)}`);
  println(io.stdout, `Added [models.profiles.${JSON.stringify(fullRef)}] to ${file}.`);
  return EXIT.ok;
}

export async function modelsList(
  io: CliIO,
  opts: { provider?: string | undefined; remote?: boolean | undefined },
): Promise<number> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  // Raw profiles (core schema may not know them yet; see INTEGRATION note).
  let rawProfiles: Record<string, ModelProfileInput> = {};
  try {
    const userText = await readUserToml(userConfigFile(resolvePaths(io.env)));
    const projectText = await readUserToml(`${io.cwd}/omnexx.toml`);
    for (const text of [projectText, userText]) {
      if (!text.trim()) continue;
      const parsed = parseToml(text) as { models?: unknown };
      Object.assign(rawProfiles, loadModelProfiles(parsed.models));
    }
  } catch {
    rawProfiles = {};
  }
  const filter = opts.provider?.toLowerCase();
  if (opts.remote) {
    const names = filter ? [filter] : Object.keys(config.providers.endpoints);
    for (const name of names) {
      const ep = config.providers.endpoints[name];
      if (!ep) {
        println(io.stdout, `${name}: not configured`);
        continue;
      }
      const key = await findProviderKey(resolvePaths(io.env), io.env, name, ep.api_key_env);
      const kind =
        (ep as { kind?: string }).kind === 'responses'
          ? undefined
          : name === 'ollama' || ep.base_url.includes('11434')
            ? ('ollama' as const)
            : undefined;
      const found = await discoverModels(
        {
          baseUrl: ep.base_url,
          ...(key?.key ? { apiKey: key.key } : {}),
          ...(kind ? { kind } : {}),
        },
        { ...(io.fetch ? { fetch: io.fetch } : {}) },
      );
      if (!found.length) println(io.stdout, `${name}: no models reported`);
      for (const m of found)
        println(io.stdout, `${name}:${m.id}${m.contextLength ? `  (ctx ${m.contextLength})` : ''}`);
    }
    return EXIT.ok;
  }
  const refs = new Set<string>();
  for (const chain of [config.models.planner, config.models.worker, config.models.cheap]) {
    for (const r of typeof chain === 'string' ? [chain] : chain) refs.add(r);
  }
  for (const r of Object.keys(rawProfiles)) refs.add(r);
  const sorted = [...refs].sort().filter((r) => !filter || r.startsWith(`${filter}:`));
  if (!sorted.length) println(io.stdout, 'no models configured');
  for (const r of sorted) {
    const p = rawProfiles[r];
    println(
      io.stdout,
      p
        ? `${r}  tags=[${p.tags.join(',')}] ctx=${p.context ?? '?'} ${p.vision ? 'vision' : ''}`.trim()
        : r,
    );
  }
  return EXIT.ok;
}

export async function modelsRemove(io: CliIO, ref: string): Promise<number> {
  const { provider, model } = splitRef(ref);
  const fullRef = `${provider}:${model}`;
  const file = userConfigFile(resolvePaths(io.env));
  const removed = await removeProfileBlock(file, fullRef);
  println(
    io.stdout,
    removed ? `Removed ${fullRef} from ${file}.` : `${fullRef} is not in ${file}.`,
  );
  return EXIT.ok;
}

export async function modelsTest(io: CliIO, ref: string): Promise<number> {
  const { provider, model } = splitRef(ref);
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const paths = resolvePaths(io.env);
  if (provider === 'anthropic') {
    const key = await findProviderKey(paths, io.env, 'anthropic');
    if (!key)
      throw new UsageError(
        'no Anthropic API key found',
        'set ANTHROPIC_API_KEY or run `omnexx auth set anthropic`',
      );
    const p = new AnthropicProvider({
      apiKey: key.key,
      cacheTtl: '5m',
      timeoutMs: 10_000,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    const res = await p.complete({
      model,
      system: [{ text: 'Reply ok.' }],
      tools: [
        { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Call ping.' }] }],
      maxTokens: 50,
      messageBreakpoints: [],
      toolChoice: { type: 'tool', name: 'ping' },
    });
    const call = res.content.find((b) => b.type === 'tool_use');
    println(
      io.stdout,
      call
        ? `ok: tool call to ${(call as { name: string }).name}`
        : 'ok: answered without a tool call',
    );
    return EXIT.ok;
  }
  if (provider === 'gemini') {
    const key = await findProviderKey(paths, io.env, 'gemini');
    const p = new GeminiProvider({
      apiKey: key?.key,
      timeoutMs: 10_000,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    const res = await p.complete({
      model,
      system: [{ text: 'Reply ok.' }],
      tools: [
        { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Call ping.' }] }],
      maxTokens: 50,
      messageBreakpoints: [],
      toolChoice: { type: 'auto' },
    });
    const call = res.content.find((b) => b.type === 'tool_use');
    println(
      io.stdout,
      call
        ? `ok: tool call to ${(call as { name: string }).name}`
        : 'ok: answered without a tool call',
    );
    return EXIT.ok;
  }
  const ep = config.providers.endpoints[provider];
  if (!ep)
    throw new UsageError(
      `unknown provider "${provider}"`,
      '`omnexx providers list` shows configured providers',
    );
  const key = await findProviderKey(paths, io.env, provider, ep.api_key_env);
  const kind = (ep as { kind?: string }).kind;
  const base = {
    baseUrl: ep.base_url,
    apiKey: key?.key,
    timeoutMs: parseDuration(ep.request_timeout),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
  const req: CompletionRequest = {
    model,
    system: [{ text: 'Reply ok.' }],
    tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Call ping.' }] }],
    maxTokens: 50,
    messageBreakpoints: [],
    toolChoice: { type: 'auto' },
  };
  const res =
    kind === 'responses'
      ? await new ResponsesProvider({ name: provider, ...base }).complete(req)
      : await new OpenAICompatProvider({ name: provider, ...base }).complete(req);
  const call = res.content.find((b) => b.type === 'tool_use');
  println(
    io.stdout,
    call
      ? `ok: tool call to ${(call as { name: string }).name}`
      : 'ok: answered without a tool call',
  );
  return EXIT.ok;
}

export const register: CommandRegistrar = (
  program: Command,
  io: CliIO,
  setExit: (c: number) => void,
) => {
  const m = program.command('models').description('add, list, remove and test model profiles');
  m.command('add <ref>')
    .description('add a model profile (provider:model)')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--ctx <tokens>', 'context window, e.g. 200000 or 200k')
    .option('--vision', 'model supports vision')
    .option('--no-tools', 'model does not support tools')
    .option('--speed <tier>', 'fast|normal|slow')
    .option('--quality <tier>', 'low|mid|high')
    .action(
      async (
        ref: string,
        opts: {
          tags?: string;
          ctx?: string;
          vision?: boolean;
          tools?: boolean;
          speed?: string;
          quality?: string;
        },
      ) => {
        const speed = opts.speed === 'fast' || opts.speed === 'slow' ? opts.speed : 'normal';
        const quality = opts.quality === 'low' || opts.quality === 'high' ? opts.quality : 'mid';
        setExit(
          await modelsAdd(io, ref, {
            tags: opts.tags,
            ctx: opts.ctx,
            vision: opts.vision,
            tools: opts.tools,
            speed,
            quality,
          }),
        );
      },
    );
  m.command('list')
    .description('list known models')
    .option('--provider <name>', 'filter by provider')
    .option('--remote', 'live discovery via /models')
    .action(async (opts: { provider?: string; remote?: boolean }) => {
      setExit(await modelsList(io, { provider: opts.provider, remote: opts.remote }));
    });
  m.command('remove <ref>')
    .description('remove a model profile')
    .action(async (ref: string) => {
      setExit(await modelsRemove(io, ref));
    });
  m.command('test <ref>')
    .description('one tool-call round trip')
    .action(async (ref: string) => {
      setExit(await modelsTest(io, ref));
    });
};
