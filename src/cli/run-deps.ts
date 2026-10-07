import { join } from 'node:path';
import { findAnthropicKey, findProviderKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import type { ConfigInput, OmnexxConfig } from '../config/schema.js';
import { parseDuration } from '../config/duration.js';
import { realClock, type Clock } from '../core/clock.js';
import { resolvePaths, type OmnexxPaths } from '../core/paths.js';
import type { RunDeps, RunHooks } from '../core/run.js';
import { NotImplementedError, UsageError } from '../errors.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { withStickyRandom } from '../providers/sticky.js';
import { withToolRepair } from '../providers/repair.js';
import { ResponsesProvider } from '../providers/responses.js';
import { ProviderRouter } from '../providers/router.js';
import type { Provider } from '../providers/types.js';
import type { CliIO } from './io.js';

export interface ResolvedDeps {
  config: OmnexxConfig;
  paths: OmnexxPaths;
  clock: Clock;
  deps: RunDeps;
}

/** "auto" = 1h for runs longer than an hour (gates between cycles outlast 5 minutes). */
export function prefixTtl(setting: 'auto' | '5m' | '1h', maxHours: number): '5m' | '1h' {
  if (setting !== 'auto') return setting;
  return maxHours > 1 ? '1h' : '5m';
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
        prefixTtl: prefixTtl(anthropic.prefix_cache_ttl, config.budget.max_hours),
        timeoutMs: parseDuration(anthropic.request_timeout),
      }),
    );
  }
  for (const [name, ep] of Object.entries(config.providers.endpoints)) {
    if (!used.has(name)) continue;
    const apiKey = (await findProviderKey(paths, io.env, name, ep.api_key_env))?.key;
    if (ep.api_key_env && !apiKey) {
      throw new UsageError(
        `provider "${name}" needs ${ep.api_key_env}`,
        `export ${ep.api_key_env}=… or run \`omnexx auth set ${name}\``,
      );
    }
    if (apiKey) secrets.push(apiKey);
    const opts = {
      name,
      baseUrl: ep.base_url,
      apiKey,
      timeoutMs: parseDuration(ep.request_timeout),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    };
    const inner =
      ep.kind === 'responses'
        ? new ResponsesProvider(opts)
        : ep.kind === 'gemini'
          ? new GeminiProvider(opts)
          : new OpenAICompatProvider(opts);
    // Weaker and local models often emit broken tool JSON; repair it before the loop sees it.
    const repaired = withToolRepair(inner);
    providers.set(
      name,
      ep.sticky_random
        ? withStickyRandom(repaired, {
            baseUrl: ep.base_url,
            apiKey,
            stateFile: join(paths.configHome, `sticky-${name}.json`),
            ...(io.fetch ? { fetch: io.fetch } : {}),
          })
        : repaired,
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
