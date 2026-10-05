import { findAnthropicKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import type { ConfigInput, OmnexxConfig } from '../config/schema.js';
import { parseDuration } from '../config/duration.js';
import { realClock, type Clock } from '../core/clock.js';
import { resolvePaths, type OmnexxPaths } from '../core/paths.js';
import type { RunDeps, RunHooks } from '../core/run.js';
import { NotImplementedError, UsageError } from '../errors.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { ProviderRouter } from '../providers/router.js';
import type { Provider } from '../providers/types.js';
import type { CliIO } from './io.js';

export interface ResolvedDeps {
  config: OmnexxConfig;
  paths: OmnexxPaths;
  clock: Clock;
  deps: RunDeps;
}

/** Config + key + provider for any command that talks to the model. The key never leaves this process. */
export async function resolveRunDeps(
  io: CliIO,
  cwd: string,
  flags: ConfigInput = {},
  hooks?: RunHooks,
): Promise<ResolvedDeps> {
  const { config } = await loadConfig({ cwd, env: io.env, flags });
  if (config.git.open_pr) throw new NotImplementedError('git.open_pr', 'M5');
  const enabledWorker = Object.entries(config.workers.backends).find(([, w]) => w.enabled);
  if (enabledWorker) {
    throw new UsageError(
      `worker "${enabledWorker[0]}" is enabled, but worker adapters are not available until M3`,
      `set [workers.${enabledWorker[0]}] enabled = false`,
    );
  }
  const paths = resolvePaths(io.env);
  // Only the providers some role's chain actually uses need a key.
  const used = new Set(
    [config.models.planner, config.models.worker, config.models.cheap]
      .flatMap((c) => (typeof c === 'string' ? [c] : c))
      .map((ref) => ref.slice(0, ref.indexOf(':'))),
  );
  const secrets: string[] = [];
  const providers = new Map<string, Provider>();
  if (used.has('anthropic')) {
    const key = await findAnthropicKey(paths, io.env);
    if (!key) {
      throw new UsageError(
        'no Anthropic API key found',
        'set ANTHROPIC_API_KEY or run `omnexx auth set anthropic`',
      );
    }
    secrets.push(key.key);
    const anthropic = config.providers.anthropic;
    providers.set(
      'anthropic',
      new AnthropicProvider({
        apiKey: key.key,
        ...(anthropic.base_url ? { baseURL: anthropic.base_url } : {}),
        cacheTtl: anthropic.cache_ttl,
        prefixTtl:
          anthropic.prefix_cache_ttl === 'auto'
            ? config.budget.max_hours > 1
              ? '1h'
              : '5m'
            : anthropic.prefix_cache_ttl,
        timeoutMs: parseDuration(anthropic.request_timeout),
      }),
    );
  }
  for (const [name, ep] of Object.entries(config.providers.endpoints)) {
    if (!used.has(name)) continue;
    const apiKey = ep.api_key_env ? io.env[ep.api_key_env]?.trim() : undefined;
    if (ep.api_key_env && !apiKey) {
      throw new UsageError(
        `provider "${name}" needs ${ep.api_key_env}`,
        `export ${ep.api_key_env}=… (Omnexx reads it from the environment only)`,
      );
    }
    if (apiKey) secrets.push(apiKey);
    providers.set(
      name,
      new OpenAICompatProvider({
        name,
        baseUrl: ep.base_url,
        apiKey,
        timeoutMs: parseDuration(ep.request_timeout),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      }),
    );
  }
  const provider: Provider = io.makeProvider
    ? io.makeProvider(secrets[0] ?? '')
    : new ProviderRouter(providers);
  const clock = io.clock ?? realClock;
  return {
    config,
    paths,
    clock,
    deps: {
      config,
      paths,
      env: io.env,
      clock,
      provider,
      fetch: io.fetch ?? globalThis.fetch,
      secrets,
      ...(hooks ? { hooks } : {}),
    },
  };
}
