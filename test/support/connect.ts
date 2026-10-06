import { PassThrough } from 'node:stream';
import type { CliIO } from '../../src/cli/io.js';
import { isolatedEnv, tempDir } from './tmp.js';

export function modelsFetch(ids: string[], seen: string[] = []): typeof fetch {
  const fn: typeof fetch = (url, init) => {
    const h = new Headers(init?.headers);
    seen.push(
      `${url instanceof Request ? url.url : url.toString()} ${h.get('authorization') ?? ''}`,
    );
    return Promise.resolve(
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }),
    );
  };
  return fn;
}

export async function testIO(fetchFn: typeof fetch, extra: NodeJS.ProcessEnv = {}): Promise<CliIO> {
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: await isolatedEnv(extra),
    cwd: await tempDir(),
    isTTY: false,
    fetch: fetchFn,
  };
}
