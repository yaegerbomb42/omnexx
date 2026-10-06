import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY_MS = 24 * 3_600_000;
const REGISTRY = 'https://registry.npmjs.org/omnexx/latest';

/** True when `a` is a newer release than `b` (plain x.y.z; pre-releases are never "newer"). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

interface Cache {
  checkedAt: number;
  latest: string;
}

/**
 * The newer published version, or undefined. Asks npm at most once a day (cached in `cacheFile`),
 * gives up after 2 s, and never throws: an update notice must not cost the user anything.
 */
export async function checkForUpdate(opts: {
  current: string;
  cacheFile: string;
  env: NodeJS.ProcessEnv;
  now?: number;
  fetch?: typeof fetch;
}): Promise<string | undefined> {
  if (opts.env.OMNEXX_NO_UPDATE_CHECK || opts.env.CI) return undefined;
  const now = opts.now ?? Date.now();
  try {
    let cache: Cache | undefined;
    try {
      cache = JSON.parse(await readFile(opts.cacheFile, 'utf8')) as Cache;
    } catch {
      cache = undefined;
    }
    if (!cache || now - cache.checkedAt > DAY_MS) {
      const res = await (opts.fetch ?? fetch)(REGISTRY, { signal: AbortSignal.timeout(2_000) });
      const { version } = (await res.json()) as { version?: unknown };
      if (typeof version !== 'string') return undefined;
      cache = { checkedAt: now, latest: version };
      await mkdir(dirname(opts.cacheFile), { recursive: true });
      await writeFile(opts.cacheFile, JSON.stringify(cache));
    }
    return isNewer(cache.latest, opts.current) ? cache.latest : undefined;
  } catch {
    return undefined;
  }
}
