import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveChat, type ChatState } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import { BUILTIN_PRICING } from '../../src/providers/pricing.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../../src/providers/types.js';
import { makeRepo } from '../support/harness.js';
import { say, ScriptedProvider, type Script } from '../support/scripted-provider.js';
import { isolatedEnv } from '../support/tmp.js';

type Out = { type: string } & Record<string, unknown>;

const TASK = 'FENCE-TOKEN-18';
const STEER = 'STEER-TOKEN-18';
const fakeServer = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/fake-server.ts');
const FAKE_CMD = `"${process.execPath}" --experimental-strip-types "${fakeServer}"`;

/** Text blocks of one completion, in order. */
function messageText(req: CompletionRequest): string {
  return req.messages
    .flatMap((m) => m.content)
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n');
}

/**
 * Scripted replies, plus a hold on the next completion so pause, stop and steer can land while
 * a request is actually in flight. The hold ends when released or when the request is aborted.
 */
class HoldingProvider implements Provider {
  readonly name = 'scripted';
  readonly requests: CompletionRequest[] = [];
  private readonly inner: ScriptedProvider;
  private held: Promise<void> | undefined;

  constructor(script: Script) {
    this.inner = new ScriptedProvider(script);
  }

  /** Block the next `complete` until `release` (or the call's abort signal). */
  holdNext(): () => void {
    let release: () => void = () => undefined;
    this.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const held = this.held;
    this.held = undefined;
    if (held) {
      await Promise.race([
        held,
        new Promise<never>((_resolve, reject) => {
          if (!req.signal) return;
          const abort = (): void => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          };
          if (req.signal.aborted) abort();
          else req.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    }
    return this.inner.complete(req);
  }
}

const script: Script = (meta) => {
  const system = meta.request.system.map((b) => b.text).join('\n');
  if (system.includes('compress a coding conversation'))
    return say(`Summary: the task is ${TASK}. Still open: finish the fence.`);
  const last = messageText(meta.request);
  const tail = last.slice(last.lastIndexOf('\n') + 1);
  if (tail.includes('paint-long')) return say(`${TASK} ${'painted. '.repeat(800)}`);
  return say(`ack:${tail.slice(0, 120)}`);
};

/** Run the chat server on in-memory pipes, the same way the other chat-server tests do. */
async function start() {
  const repo = await makeRepo();
  const provider = new HoldingProvider(script);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: Out[] = [];
  let buf = '';
  stdout.on('data', (c: Buffer) => {
    buf += c.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) out.push(JSON.parse(l) as Out);
  });
  const io: CliIO = {
    stdout,
    stderr: new PassThrough(),
    stdin,
    env: await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' }),
    cwd: repo,
    isTTY: false,
    makeProvider: () => provider,
    fetch: () => Promise.reject(new Error('no network in tests')),
  };
  let exited = false;
  const done = serveChat(io, () => Promise.resolve(0), { version: '9.9.9' }).finally(() => {
    exited = true;
  });
  const send = (cmd: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  const states = (): ChatState[] => out.filter((o): o is Out & ChatState => o.type === 'state');
  const entries = (): ChatState['entries'] => states().flatMap((s) => s.entries);
  let seen = 0;
  const until = async <T>(fn: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** The next message of this type after everything already waited for. */
  const next = async (type: string, test: (o: Out) => boolean = () => true): Promise<Out> => {
    const found = await until(() => {
      const i = out.findIndex((o, n) => n >= seen && o.type === type && test(o));
      return i >= 0 ? i : undefined;
    }, type);
    seen = found + 1;
    return out[found] as Out;
  };
  await next('ready');
  return { provider, send, out, states, entries, until, next, stdin, done, exited: () => exited };
}

async function close(t: Awaited<ReturnType<typeof start>>): Promise<void> {
  t.stdin.end();
  await t.done;
}

/** Wait until the panel has the assistant line and the turn is idle. */
async function settled(t: Awaited<ReturnType<typeof start>>, needle: string): Promise<ChatState> {
  return t.until(() => {
    const s = t.states().at(-1);
    if (!s || s.busy) return undefined;
    return t.entries().some((e) => e.kind === 'out' && e.text.includes(needle)) ? s : undefined;
  }, needle);
}

/** One in-flight completion, held until `release`. */
async function holdOne(t: Awaited<ReturnType<typeof start>>, text: string): Promise<() => void> {
  const release = t.provider.holdNext();
  t.send({ type: 'send', text });
  await t.until(() => (t.provider.requests.length === 1 ? true : undefined), 'in-flight request');
  return release;
}

describe('chat-server flows (what the VS Code panel drives)', () => {
  let t: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    t = await start();
  });
  afterEach(async () => {
    await close(t);
  });

  it('model: the picked ref is the model id on the next completion', async () => {
    t.send({ type: 'models' });
    const models = await t.next('models');
    const items = models.items as { ref: string }[];
    expect(items.map((i) => i.ref)).toContain('anthropic:haiku');

    t.send({ type: 'model', ref: 'anthropic:haiku' });
    const picked = await t.until(
      () => t.states().find((s) => s.model === 'anthropic:haiku'),
      'model anthropic:haiku',
    );
    expect(picked.model).toBe('anthropic:haiku');

    t.send({ type: 'send', text: 'hello from haiku' });
    const req = await t.until(
      () => t.provider.requests.find((r) => messageText(r).includes('hello from haiku')),
      'haiku completion',
    );
    const haikuId = BUILTIN_PRICING.haiku?.id;
    if (!haikuId) throw new Error('haiku price missing');
    expect(req.model).toBe(haikuId);
    await settled(t, 'ack:hello from haiku');
    expect(t.exited()).toBe(false);
  });

  it('send: the assistant reply arrives as a state entry the panel renders', async () => {
    t.send({ type: 'send', text: 'paint the fence' });
    const s = await settled(t, 'ack:paint the fence');
    const reply = t.entries().find((e) => e.kind === 'out');
    expect(reply?.text).toContain('ack:paint the fence');
    expect(s.live).toBe('');
    expect(s.busy).toBe(false);
  });

  it('stop: the in-flight turn ends and a later send still gets a reply', async () => {
    const release = await holdOne(t, 'start a long turn');
    t.send({ type: 'stop' });
    await t.until(() => {
      const s = t.states().at(-1);
      const stopped = t
        .entries()
        .some((e) => e.text.includes('stopped. tell me what to do instead'));
      return s && !s.busy && stopped ? s : undefined;
    }, 'stopped');
    release();
    const during = t.provider.requests.length;

    t.send({ type: 'send', text: 'after the stop' });
    await settled(t, 'ack:after the stop');
    expect(t.provider.requests.length).toBeGreaterThan(during);
    expect(t.exited()).toBe(false);
  });

  it('pause then resume: no completion while held, then the turn continues', async () => {
    const release = await holdOne(t, 'work until paused');
    t.send({ type: 'pause' });
    await t.until(() => {
      const s = t.states().at(-1);
      const held = t.entries().some((e) => e.text.includes('paused. /resume carries on'));
      return s && !s.busy && held ? s : undefined;
    }, 'paused');
    const heldAt = t.provider.requests.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(t.provider.requests.length).toBe(heldAt);
    release();

    t.send({ type: 'resume' });
    const req = await t.until(
      () =>
        t.provider.requests.find((r) => messageText(r).includes('Continue where you left off.')),
      'resume completion',
    );
    expect(messageText(req)).toContain('Continue where you left off.');
    await settled(t, 'ack:Continue where you left off.');
    expect(t.entries().some((e) => e.text === 'resumed')).toBe(true);
  });

  it('steer mid-turn via send: the next completion contains the steering text', async () => {
    // CodeChat holds a mid-turn send aside and aborts the step, then answers it as the next
    // turn. `pendingInput` / `steer.applied` only fire for the loop queue, which this path
    // never fills, so the panel's line is "switching to your message now".
    const release = await holdOne(t, 'original task');
    t.send({ type: 'send', text: STEER });
    const req = await t.until(
      () => t.provider.requests.find((r) => messageText(r).includes(STEER)),
      'steered completion',
    );
    expect(messageText(req)).toContain(STEER);
    expect(t.entries().some((e) => e.text.includes('switching to your message now'))).toBe(true);
    await settled(t, `ack:${STEER}`);
    release();
  });

  it('compact: context shrinks and the next turn still knows the task', async () => {
    t.send({ type: 'send', text: 'paint-long the fence' });
    await settled(t, TASK);
    t.send({ type: 'send', text: 'note the gate' });
    const before = await settled(t, 'ack:note the gate');
    const used = before.context?.used ?? 0;
    expect(used).toBeGreaterThan(0);

    t.send({ type: 'compact' });
    await t.until(
      () => (t.entries().some((e) => e.text.includes('compacted: ')) ? true : undefined),
      'compacted',
    );
    const after = await t.until(() => {
      const s = t.states().at(-1);
      const usedNow = s?.context?.used;
      return usedNow !== undefined && usedNow < used ? s : undefined;
    }, 'smaller context');
    expect(after.context?.used).toBeLessThan(used);

    t.send({ type: 'send', text: 'what is still open?' });
    const req = await t.until(
      () => t.provider.requests.find((r) => messageText(r).includes('what is still open?')),
      'post-compact completion',
    );
    expect(messageText(req)).toContain(`Summary: the task is ${TASK}`);
    await settled(t, 'ack:what is still open?');
  });

  it('clear: a new saved chat id, and the previous messages stay readable', async () => {
    t.send({ type: 'send', text: 'remember the blue fence' });
    await settled(t, 'ack:remember the blue fence');

    t.send({ type: 'chats' });
    const prior = await t.next('chats');
    const before = new Set((prior.chats as { id: string }[]).map((c) => c.id));

    t.send({ type: 'clear' });
    await t.next('ready');
    const fresh = await t.until(() => {
      const readyAt = t.out.findLastIndex((o) => o.type === 'ready');
      return t.out.slice(readyAt + 1).find((o) => o.type === 'state') as ChatState | undefined;
    }, 'state after new chat');
    expect(fresh.entries.map((e) => e.text).join('\n')).not.toContain('remember the blue fence');

    t.send({ type: 'chats' });
    const listed = await t.next('chats');
    const chats = listed.chats as { id: string; title: string }[];
    const added = chats.filter((c) => !before.has(c.id));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((c) => c.id.startsWith('chat_'))).toBe(true);
    const saved = added.find((c) => /blue fence/i.test(c.title));
    if (!saved) throw new Error('archived chat missing');
    expect(saved.title).toMatch(/blue fence/i);

    t.send({ type: 'resumeChat', id: saved.id });
    await t.until(
      () =>
        t.entries().some((e) => e.kind === 'user' && e.text.includes('remember the blue fence'))
          ? true
          : undefined,
      'reopened transcript',
    );
  });

  it('mcp enable: toggling on and off is reflected in mcpServers', async () => {
    const mcp = (op: Record<string, unknown>): void => {
      t.send({ type: 'mcp', ...op });
    };
    const settledList = (): Promise<Out> => t.next('mcpServers', (o) => o.checking === false);
    const servers = (o: Out): { name: string; state: string }[] =>
      o.servers as { name: string; state: string }[];

    mcp({ op: 'add', via: 'command', name: 'demo', command: FAKE_CMD });
    expect(await t.next('mcpResult')).toMatchObject({ ok: true });
    expect(servers(await settledList())[0]).toMatchObject({ name: 'demo', state: 'running' });

    mcp({ op: 'enable', name: 'demo', on: false });
    expect(await t.next('mcpResult')).toMatchObject({
      ok: true,
      message: 'Disabled MCP server "demo".',
    });
    expect(servers(await settledList())[0]?.state).toBe('disabled');

    mcp({ op: 'enable', name: 'demo', on: true });
    expect(await t.next('mcpResult')).toMatchObject({
      ok: true,
      message: 'Enabled MCP server "demo".',
    });
    expect(servers(await settledList())[0]?.state).toBe('running');

    mcp({ op: 'remove', name: 'demo' });
    expect(await t.next('mcpResult')).toMatchObject({ ok: true });
  });
});
