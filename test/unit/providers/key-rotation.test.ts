import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../src/errors.js';
import { withKeyRotation } from '../../../src/providers/key-rotation.js';
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
} from '../../../src/providers/types.js';

const req = {
  model: 'm',
  system: [],
  tools: [],
  messages: [],
  maxTokens: 10,
} as unknown as CompletionRequest;
const res = (k: string) => ({ model: k }) as unknown as CompletionResponse;

function client(key: string, script: ('ok' | 429 | 500)[]): Provider & { calls: number } {
  const c = {
    name: 'mistral',
    calls: 0,
    complete() {
      const step = script[c.calls++] ?? 'ok';
      if (step === 'ok') return Promise.resolve(res(key));
      return Promise.reject(new ProviderError(`error ${step}`, { retryable: true, status: step }));
    },
  };
  return c;
}

describe('withKeyRotation', () => {
  it('moves to the next key on 429 and stays there', async () => {
    const a = client('a', [429]);
    const b = client('b', []);
    const rotations: [number, number][] = [];
    const p = withKeyRotation([a, b], (f, t) => rotations.push([f, t]));
    expect((await p.complete(req)).model).toBe('b');
    expect((await p.complete(req)).model).toBe('b');
    expect(a.calls).toBe(1);
    expect(rotations).toEqual([[0, 1]]);
  });

  it('throws the 429 once every key is limited, and other errors at once', async () => {
    await expect(
      withKeyRotation([client('a', [429]), client('b', [429])]).complete(req),
    ).rejects.toMatchObject({ status: 429 });
    const b = client('b', []);
    await expect(withKeyRotation([client('a', [500]), b]).complete(req)).rejects.toMatchObject({
      status: 500,
    });
    expect(b.calls).toBe(0);
  });

  it('a single client is returned as is', () => {
    const a = client('a', []);
    expect(withKeyRotation([a])).toBe(a);
  });
});

describe('withKeyRotation: rejected keys (401/403)', () => {
  const reject = (_key: string, status: 401 | 403): Provider & { calls: number } => {
    const c = {
      name: 'nvidia',
      calls: 0,
      complete() {
        c.calls++;
        return Promise.reject(
          new ProviderError(`nvidia error ${String(status)}: Authorization failed`, {
            retryable: false,
            status,
          }),
        );
      },
    };
    return c;
  };

  it('skips a 403 key, benches it, and never calls it again', async () => {
    const bad = reject('k7', 403);
    const bad2 = reject('k10', 401);
    const good = client('k1', []);
    const benched: number[] = [];
    const p = withKeyRotation([bad, bad2, good], undefined, (i) => benched.push(i));
    expect((await p.complete(req)).model).toBe('k1');
    expect((await p.complete(req)).model).toBe('k1');
    expect(bad.calls).toBe(1);
    expect(bad2.calls).toBe(1);
    expect(benched).toEqual([0, 1]);
  });

  it('a 429 on the good key still rotates past benched keys, and all-bad throws the auth error', async () => {
    const good = client('k1', [429]);
    const other = client('k2', []);
    const p = withKeyRotation([reject('k7', 403), good, other]);
    expect((await p.complete(req)).model).toBe('k2');
    await expect(
      withKeyRotation([reject('a', 403), reject('b', 401)]).complete(req),
    ).rejects.toMatchObject({ status: 401 });
  });
});
