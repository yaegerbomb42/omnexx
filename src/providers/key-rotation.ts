import { ProviderError } from '../errors.js';
import type { CompletionRequest, CompletionResponse, Provider } from './types.js';

/** Per-key failures: 429 is a temporary limit; 401/403 mean this key is bad (revoked, no access). */
const isRateLimit = (s: number | undefined): boolean => s === 429;
const isKeyRejected = (s: number | undefined): boolean => s === 401 || s === 403;

/**
 * One endpoint, several keys (free tiers rate-limit per key). Calls stay on the current key;
 * a 429 moves to the next key and retries at once. A 401/403 also moves on, and that key is
 * benched for the rest of the process (a revoked key in the pool must not stall a run). Only
 * when every key failed this way does the error reach the retry and failover logic: 429 when
 * any key was merely rate-limited, otherwise the auth error.
 */
export function withKeyRotation(
  clients: readonly Provider[],
  onRotate?: (from: number, to: number) => void,
  onKeyRejected?: (index: number, status: number) => void,
): Provider {
  const first = clients[0];
  if (!first) throw new Error('withKeyRotation needs at least one client');
  if (clients.length === 1) return first;
  let current = 0;
  const benched = new Set<number>();
  return {
    name: first.name,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      let lastErr: unknown;
      let lastLimit: unknown;
      for (let tried = 0; tried < clients.length; tried++) {
        const i = (current + tried) % clients.length;
        // Benched keys are skipped while any other key is still usable.
        if (benched.has(i) && benched.size < clients.length) continue;
        try {
          const res = await (clients[i] as Provider).complete(req);
          if (i !== current) {
            onRotate?.(current, i);
            current = i;
          }
          return res;
        } catch (err) {
          if (!(err instanceof ProviderError) || req.signal?.aborted) throw err;
          if (isKeyRejected(err.status)) {
            if (!benched.has(i)) {
              benched.add(i);
              onKeyRejected?.(i, err.status ?? 0);
            }
            lastErr = err;
            continue;
          }
          if (!isRateLimit(err.status)) throw err;
          lastLimit = err;
        }
      }
      throw lastLimit ?? lastErr;
    },
  };
}
