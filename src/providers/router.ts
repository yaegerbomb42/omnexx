import { ProviderError } from '../errors.js';
import { isQuotaError } from './sticky.js';
import { ProviderCircuitBreaker, type ProviderCircuitOptions } from './circuit-breaker.js';
import type { QuotaLedger } from './quota-ledger.js';
import type { CompletionRequest, CompletionResponse, Provider } from './types.js';

export interface ProviderRouterOptions {
  /** Route name → provider. */
  providers: ReadonlyMap<string, Provider>;
  /** Route name → ordered fallback route names to try when the primary fails (429/5xx). */
  fallbacks?: ReadonlyMap<string, readonly string[]>;
  /** Per-route circuit breakers (created if absent). */
  circuits?: ReadonlyMap<string, ProviderCircuitBreaker>;
  /** Quota ledger for skipping exhausted/rate-limited routes. */
  quota?: QuotaLedger;
  /** Current time for deterministic testing. */
  now?: () => number;
}

const FALLBACK_RATE_LIMIT_MS = 60_000;

/**
 * Dispatches each call to the provider named in `req.route` (default "anthropic"), failing over
 * to configured fallbacks on 429/5xx (guarded by a circuit breaker) and generally skipping routes
 * the quota ledger says are exhausted or rate-limited. The turn is resumed transparently: the
 * same request is replayed against whichever provider takes it.
 */
export class ProviderRouter implements Provider {
  readonly name = 'router';

  private readonly providers: ReadonlyMap<string, Provider>;
  private readonly fallbacks: ReadonlyMap<string, readonly string[]>;
  private readonly quota: QuotaLedger | undefined;
  private readonly now: () => number;
  private readonly circuits: Map<string, ProviderCircuitBreaker>;
  private readonly circuitOpts: ProviderCircuitOptions;

  constructor(options: ProviderRouterOptions) {
    this.providers = options.providers;
    this.fallbacks = options.fallbacks ?? new Map();
    this.quota = options.quota;
    this.now = options.now ?? Date.now;
    this.circuits = new Map(options.circuits ?? []);
    this.circuitOpts = { now: this.now };
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  private circuit(route: string): ProviderCircuitBreaker {
    let c = this.circuits.get(route);
    if (!c) {
      c = new ProviderCircuitBreaker(this.circuitOpts);
      this.circuits.set(route, c);
    }
    return c;
  }

  private orderFor(route: string): string[] {
    const order = [route, ...(this.fallbacks.get(route) ?? [])];
    const seen = new Set<string>();
    return order.filter((r) => {
      if (seen.has(r)) return false;
      seen.add(r);
      return this.providers.has(r);
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const primary = req.route ?? 'anthropic';
    const order = this.orderFor(primary);
    if (order.length === 0) {
      return Promise.reject(
        new ProviderError(`provider "${primary}" is not available (missing key?)`, {
          retryable: false,
          status: 401,
          hint: '`omnexx doctor` lists providers and keys',
        }),
      );
    }

    let lastError: unknown;
    for (const route of order) {
      if (this.quota?.isOut(route)) continue;
      const cb = this.circuit(route);
      if (!cb.allow()) {
        lastError = new ProviderError(`provider "${route}" is cooling down`, {
          retryable: true,
          status: 503,
        });
        continue;
      }
      const p = this.providers.get(route);
      if (!p) continue;
      try {
        const res = await p.complete(req);
        cb.recordSuccess();
        return res;
      } catch (err) {
        lastError = err;
        if (!shouldFailover(err)) throw err;
        cb.recordFailure();
        if (isQuotaError(err)) {
          this.quota?.mark(`${route}:${req.model}`);
        } else if (err instanceof ProviderError && err.status === 429) {
          this.quota?.mark(`${route}:${req.model}`, FALLBACK_RATE_LIMIT_MS);
        }
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new ProviderError(`no provider could take the call for "${primary}"`, {
      retryable: true,
      status: 503,
    });
  }
}

/**
 * Whether to move on to the next model in a chain after this error. A 400 is our own malformed
 * request, so trying elsewhere won't help (unless a content filter refused it or it says the model is out of quota); anything else (outage, rate limit, quota, bad key,
 * unknown model) might work on another provider.
 */
export function shouldFailover(err: unknown): err is ProviderError {
  return (
    err instanceof ProviderError &&
    (err.status !== 400 || err.contentFilter || isQuotaError(err)) &&
    err.message !== 'request aborted'
  );
}
