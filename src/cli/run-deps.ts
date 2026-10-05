import { findAnthropicKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import type { ConfigInput, OmnexxConfig } from '../config/schema.js';
import { parseDuration } from '../config/duration.js';
import { realClock, type Clock } from '../core/clock.js';
import { resolvePaths, type OmnexxPaths } from '../core/paths.js';
import type { RunDeps, RunHooks } from '../core/run.js';
import { NotImplementedError, UsageError } from '../errors.js';
import { AnthropicProvider } from '../providers/anthropic.js';
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
  const key = await findAnthropicKey(paths, io.env);
  if (!key)
    throw new UsageError(
      'no Anthropic API key found',
      'set ANTHROPIC_API_KEY or run `omnexx auth set anthropic`',
    );
  const anthropic = config.providers.anthropic;
  const provider = io.makeProvider
    ? io.makeProvider(key.key)
    : new AnthropicProvider({
        apiKey: key.key,
        ...(anthropic.base_url ? { baseURL: anthropic.base_url } : {}),
        cacheTtl: anthropic.cache_ttl,
        timeoutMs: parseDuration(anthropic.request_timeout),
      });
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
      secrets: [key.key],
      ...(hooks ? { hooks } : {}),
    },
  };
}
