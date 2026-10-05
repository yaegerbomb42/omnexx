/**
 * The built-in `swarm` endpoint: an OpenAI-compatible gateway that routes each request to a pool
 * of models rather than one model. Pools are hardcoded so `swarm:<pool>` works with no
 * [providers.endpoints] block; declaring `[providers.endpoints.swarm]` replaces these defaults.
 */
export const SWARM_PROVIDER = 'swarm';

export const SWARM_POOLS = {
  '4.1-pool': 'DeepSeek V4.1',
  'fast-pool': 'sub-500 ms low-latency pool',
  'groq-pool': 'Groq accelerated pool',
  'mistral-pool': 'Mistral pool',
  'nim-pool': 'NVIDIA NIM pool',
} as const;
export type SwarmPool = keyof typeof SWARM_POOLS;

export function isSwarmPool(name: string): name is SwarmPool {
  return Object.hasOwn(SWARM_POOLS, name);
}

/** Raw (pre-parse) endpoint config; the key lives in the env var, never here. */
export const SWARM_ENDPOINT = {
  kind: 'openai',
  base_url: 'https://swarmconnect.site/api/v1',
  api_key_env: 'SWARM_API_KEY',
  free: true,
} as const;
