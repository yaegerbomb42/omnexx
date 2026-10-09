import { ProviderError } from '../errors.js';
import type { CompletionRequest, CompletionResponse, Provider } from './types.js';

/**
 * One endpoint, several keys (free tiers rate-limit per key). Calls stay on the current key;
 * a 429 moves to the next key and retries at once. Only when every key answered 429 does the
 * error reach the retry and failover logic.
 */
export function withKeyRotation(
  clients: readonly Provider[],
  onRotate?: (from: number, to: number) => void,
): Provider {
  const first = clients[0];
  if (!first) throw new Error('withKeyRotation needs at least one client');
  if (clients.length === 1) return first;
  let current = 0;
  return {
    name: first.name,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      let lastErr: unknown;
      for (let tried = 0; tried < clients.length; tried++) {
        const i = (current + tried) % clients.length;
        try {
          const res = await (clients[i] as Provider).complete(req);
          if (i !== current) {
            onRotate?.(current, i);
            current = i;
          }
          return res;
        } catch (err) {
          if (!(err instanceof ProviderError) || err.status !== 429 || req.signal?.aborted)
            throw err;
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}
