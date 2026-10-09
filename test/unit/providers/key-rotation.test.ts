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
