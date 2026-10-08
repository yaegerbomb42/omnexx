import { ProviderError } from '../errors.js';
import type { CompletionRequest, CompletionResponse, Provider } from './types.js';

/** Dispatches each call to the configured provider named in `req.route` (default "anthropic"). */
export class ProviderRouter implements Provider {
  readonly name = 'router';

  constructor(private readonly providers: ReadonlyMap<string, Provider>) {}

  has(name: string): boolean {
    return this.providers.has(name);
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    const name = req.route ?? 'anthropic';
    const p = this.providers.get(name);
    if (!p) {
      return Promise.reject(
        new ProviderError(`provider "${name}" is not available (missing key?)`, {
          retryable: false,
          status: 401,
          hint: '`omnexx doctor` lists providers and keys',
        }),
      );
    }
    return p.complete(req);
  }
}

/**
 * Whether to move on to the next model in a chain after this error. A 400 is our own malformed
 * request, so trying elsewhere won't help (unless a content filter refused it); anything else (outage, rate limit, quota, bad key,
 * unknown model) might work on another provider.
 */
export function shouldFailover(err: unknown): err is ProviderError {
  return (
    err instanceof ProviderError &&
    (err.status !== 400 || err.contentFilter) &&
    err.message !== 'request aborted'
  );
}
