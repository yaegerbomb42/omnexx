/** HTTP helpers shared by web_fetch and web_search: per-attempt timeouts, retries, size caps. */

export interface RetryOptions {
  /** Per attempt; a hung server never stalls the run longer than this. */
  timeoutMs: number;
  /** Extra attempts after the first, for network errors, 429 and 5xx. */
  retries?: number;
  /** Delay before retry n is baseDelayMs * 2^n, or the server's Retry-After when shorter. */
  baseDelayMs?: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
/** A Retry-After longer than this isn't worth waiting for inside a tool call. */
const MAX_RETRY_AFTER_MS = 5_000;

const retryable = (status: number): boolean => status === 429 || status >= 500;

function retryDelay(res: Response | undefined, attempt: number, base: number): number {
  const backoff = base * 2 ** attempt;
  const after = Number(res?.headers.get('retry-after'));
  return Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_AFTER_MS) : backoff;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a timeout on every attempt and retries on transient failures (network errors,
 * timeouts, 429, 5xx). Returns the last response (possibly an error status) or throws the last
 * network error with the attempt count.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      if (!retryable(res.status) || attempt === retries) return res;
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      lastErr =
        err instanceof Error && err.name === 'TimeoutError'
          ? new Error(`timed out after ${opts.timeoutMs}ms`)
          : err;
      if (attempt === retries) break;
    }
    await sleep(retryDelay(res, attempt, base));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${msg} (after ${retries + 1} attempts)`);
}

export interface CappedBody {
  text: string;
  /** The body was longer than the cap and was cut there. */
  truncated: boolean;
}

/** Reads at most `maxBytes` of a body, then stops downloading. */
export async function readCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  if (!res.body) return { text: '', truncated: false };
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf-8'), truncated };
}
