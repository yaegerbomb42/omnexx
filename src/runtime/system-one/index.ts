import type { EventLog } from '../../core/events.js';
import type { OmnexxConfig } from '../../config/schema.js';
import { SystemOneClient } from './client.js';
import { SystemOneMiddleware } from './middleware.js';

export * from './types.js';
export { SystemOneClient, DEFAULT_SYSTEM_ONE_MODEL, DEFAULT_SYSTEM_ONE_URL } from './client.js';
export { SystemOneMiddleware } from './middleware.js';
export { snapshotFromEvents, reduceSystemOneEvent, emptySystemOneSnapshot } from './observe.js';
export type { SystemOneObserveSnapshot } from './observe.js';

/** The System-1 API key: `[system_one] api_key_env`, then TYPESAFE_API_KEY, then JEV_API_KEY. */
export function systemOneApiKey(
  config: Pick<OmnexxConfig, 'system_one'>,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const name of [config.system_one.api_key_env, 'TYPESAFE_API_KEY', 'JEV_API_KEY']) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function systemOneClient(
  config: Pick<OmnexxConfig, 'system_one' | 'kernel'>,
  env: Record<string, string | undefined>,
): SystemOneClient {
  const c = config.system_one;
  const apiKey = systemOneApiKey(config, env);
  return new SystemOneClient({
    backend: c.backend,
    baseUrl: c.base_url,
    model:
      env.TYPESAFE_DEFAULT_MODEL && c.model === 'jev-latest' ? env.TYPESAFE_DEFAULT_MODEL : c.model,
    ...(apiKey ? { apiKey } : {}),
    ollamaUrl: c.ollama_url ?? config.kernel.ollama_url,
    ollamaModel: c.ollama_model,
    timeoutMs: c.timeout_ms,
  });
}

/** The loop middleware, or undefined when `[system_one] enabled = false`. */
export function createSystemOneIfEnabled(
  config: Pick<OmnexxConfig, 'system_one' | 'kernel'>,
  repoRoot: string,
  events: EventLog,
  env: Record<string, string | undefined>,
): SystemOneMiddleware | undefined {
  const c = config.system_one;
  if (!c.enabled) return undefined;
  return new SystemOneMiddleware(
    systemOneClient(config, env),
    {
      destructiveThreshold: c.destructive_threshold,
      earlyStopThreshold: c.early_stop_threshold,
      speculativeThreshold: c.speculative_threshold,
      patchPlaceholderThreshold: c.patch_placeholder_threshold,
      gates: {
        guardrail: c.guardrail,
        earlyStop: c.early_stop,
        outputTriage: c.output_triage,
        speculativeRouting: c.speculative_routing,
        patchSanity: c.patch_sanity,
      },
    },
    events,
    repoRoot,
  );
}
