import { findProviderKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { upsertTomlKeys } from '../config/toml-file.js';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { connectFromEnv, envKeys, providerForKey } from './connect.js';
import { println, readLine, readSecret, type CliIO } from './io.js';
import { probeProvider, setupProvider } from './provider-setup.js';

const MODEL_REF = /^[a-z][a-z0-9_-]*:\S+$/;
/** Defaults when the provider lists no models: only the ones that never change. */
const KNOWN_DEFAULTS: Record<string, string> = { anthropic: 'anthropic:sonnet' };

/**
 * Whether any provider can be called at all (no network): a key, or a free endpoint.
 * (The TUI has the same check in tui/chat.ts; this copy keeps the CLI free of a tui import.)
 */
async function hasProvider(io: CliIO): Promise<boolean> {
  const paths = resolvePaths(io.env);
  if (await findProviderKey(paths, io.env, 'anthropic')) return true;
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  for (const [n, ep] of Object.entries(config.providers.endpoints)) {
    if (ep.free || (await findProviderKey(paths, io.env, n, ep.api_key_env))) return true;
  }
  return false;
}

/**
 * First run asks for two things only:
 *   1. a provider plus a key — keys already in the environment are used as-is, otherwise
 *      paste one (its provider is recognised from the key); and
 *   2. a model — the provider's first listed model, or a typed provider:model ref.
 * Everything else keeps its default. The answers land in the unified config (provider and
 * model keys); the key itself goes to the 0600 secrets file, never to config.toml.
 * Non-interactive runs get the two steps as text and carry on without a provider.
 */
export async function ensureFirstRun(io: CliIO): Promise<boolean> {
  if (await hasProvider(io).catch(() => true)) return true;
  if (!io.isTTY) {
    println(
      io.stdout,
      'no model set up yet: run `omnexx` and paste an API key, or `omnexx auth set <provider>`',
    );
    return false;
  }
  // 1. Provider + key.
  let provider: string;
  let suggested: string | undefined;
  const found = await envKeys(io).catch(() => []);
  if (found.length) {
    const connected = await connectFromEnv(io);
    provider = connected[0]?.name ?? found[0]?.name ?? 'anthropic';
    println(
      io.stdout,
      `using the keys in your environment: ${connected.map((c) => c.label).join(', ')}`,
    );
    const probe = await probeProvider(io, { provider }).catch(() => undefined);
    if (probe?.models[0]) suggested = `${provider}:${probe.models[0]}`;
  } else {
    const key = await readSecret(
      io,
      'Paste an API key (Anthropic, OpenAI, Gemini, xAI, Groq, OpenRouter, Mistral, …): ',
    );
    if (!key?.trim()) {
      println(
        io.stdout,
        'no key: run `omnexx` for the guided setup, or add a free local model with `/connect ollama`',
      );
      return false;
    }
    let name = providerForKey(key);
    if (!name) {
      name = (await readLine(io, 'Which provider is that key for? '))?.trim().toLowerCase();
      if (!name) {
        println(io.stdout, 'no provider: run `omnexx` for the guided setup');
        return false;
      }
    }
    const setup = await setupProvider(io, { provider: name, key: key.trim() });
    provider = setup.name;
    if (setup.probe.models[0]) suggested = `${provider}:${setup.probe.models[0]}`;
    println(io.stdout, setup.message);
  }
  // 2. Model.
  suggested ??= KNOWN_DEFAULTS[provider];
  let model: string | undefined;
  for (let attempt = 0; attempt < 3 && !model; attempt++) {
    const answer = (
      await readLine(io, suggested ? `Model [${suggested}]: ` : 'Model (provider:model): ')
    )?.trim();
    if (answer && MODEL_REF.test(answer)) model = answer;
    else if (!answer && suggested) model = suggested;
    else if (answer)
      println(
        io.stdout,
        `"${answer}" is not a model (expected provider:model, e.g. anthropic:sonnet)`,
      );
  }
  if (!model) {
    println(io.stdout, 'no model picked: run `omnexx` and pick one with /model');
    return false;
  }
  await upsertTomlKeys(userConfigFile(resolvePaths(io.env)), { provider, model });
  println(io.stdout, `ready: ${model} (provider ${provider})`);
  return true;
}
