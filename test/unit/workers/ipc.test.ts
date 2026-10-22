import { describe, expect, it } from 'vitest';
import {
  createPipePair,
  IpcClosedError,
  IpcRemoteError,
  IpcTimeoutError,
  type IpcEnvelope,
} from '../../../src/workers/ipc.js';

describe('PipeEndpoint send/receive', () => {
  it('delivers both directions with stamped ids', () => {
    const [a, b] = createPipePair();
    const atB: IpcEnvelope[] = [];
    const atA: IpcEnvelope[] = [];
    b.onMessage((e) => atB.push(e));
    a.onMessage((e) => atA.push(e));

    const sent = a.send({ kind: 'task.assign', payload: { id: 1 } });
    b.send({ kind: 'task.progress', payload: { pct: 50 } });

    expect(atB).toHaveLength(1);
    expect(atB[0]?.kind).toBe('task.assign');
    expect(atB[0]?.payload).toEqual({ id: 1 });
    expect(atB[0]?.id).toBe(sent.id);
    expect(sent.id.startsWith('a:')).toBe(true);
    expect(atA).toHaveLength(1);
    expect(atA[0]?.kind).toBe('task.progress');
    expect(atA[0]?.id.startsWith('b:')).toBe(true);
  });

  it('stops delivering to an unsubscribed handler', () => {
    const [a, b] = createPipePair();
    const seen: IpcEnvelope[] = [];
    const off = b.onMessage((e) => seen.push(e));
    a.send({ kind: 'one', payload: null });
    off();
    a.send({ kind: 'two', payload: null });
    expect(seen.map((e) => e.kind)).toEqual(['one']);
  });
});

describe('PipeEndpoint request/reply', () => {
  it('resolves with the reply payload, correlated by id', async () => {
    const [a, b] = createPipePair();
    b.onMessage((e) => {
      if (e.kind === 'echo') b.reply(e, { echoed: e.payload });
    });
    const reply = await a.request<{ echoed: string }>('echo', 'hello');
    expect(reply.payload).toEqual({ echoed: 'hello' });
    expect(reply.replyTo).toBeDefined();
  });

  it('matches out-of-order replies to their requests', async () => {
    const [a, b] = createPipePair();
    const inbox: IpcEnvelope[] = [];
    b.onMessage((e) => inbox.push(e));

    const one = a.request<string>('job', 'one');
    const two = a.request<string>('job', 'two');
    expect(inbox).toHaveLength(2);
    // Reply in reverse order; correlation by replyTo must still sort them out.
    const second = inbox[1];
    const first = inbox[0];
    if (!first || !second) throw new Error('expected two requests at the peer');
    b.reply(second, 'result-two');
    b.reply(first, 'result-one');

    await expect(one).resolves.toMatchObject({ payload: 'result-one' });
    await expect(two).resolves.toMatchObject({ payload: 'result-two' });
  });

  it('rejects with IpcRemoteError when the peer replies with an error', async () => {
    const [a, b] = createPipePair();
    b.onMessage((e) => b.replyError(e, 'cannot do that'));
    await expect(a.request('job', null)).rejects.toBeInstanceOf(IpcRemoteError);
    await expect(a.request('job', null)).rejects.toThrow('cannot do that');
  });

  it('rejects with IpcTimeoutError when no reply arrives', async () => {
    const [a] = createPipePair();
    await expect(a.request('nobody-listens', null, 25)).rejects.toBeInstanceOf(IpcTimeoutError);
  });
});

describe('PipeEndpoint close', () => {
  it('rejects pending requests and makes sends throw, on both ends', async () => {
    const [a, b] = createPipePair();
    const pending = a.request('never-answered', null, 60_000);
    const rejection = expect(pending).rejects.toBeInstanceOf(IpcClosedError);
    a.close();
    await rejection;

    expect(a.isClosed).toBe(true);
    expect(() => a.send({ kind: 'x', payload: null })).toThrow(IpcClosedError);
    await expect(a.request('x', null)).rejects.toBeInstanceOf(IpcClosedError);
    // The peer's sends fail fast too: there is nobody left to deliver to.
    expect(() => b.send({ kind: 'x', payload: null })).toThrow(IpcClosedError);
    // Closing twice is harmless.
    a.close();
  });
});
