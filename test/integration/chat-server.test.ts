import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveChat, type ChatState } from '../../src/cli/chat-server.js';
import type { CliIO } from '../../src/cli/io.js';
import { makeRepo } from '../support/harness.js';
import { call, say, ScriptedProvider } from '../support/scripted-provider.js';
import { isolatedEnv } from '../support/tmp.js';

type Out = { type: string } & Record<string, unknown>;

/** Run the chat server on in-memory pipes; `send` writes one command, `until` waits for output. */
async function start() {
  const repo = await makeRepo();
  const provider = new ScriptedProvider(({ turn }) =>
    turn === 0
      ? call('write_file', { path: 'src/a.js', content: 'export const a = 1;\n' })
      : turn === 1
        ? call('bash', { command: 'sudo ls' })
        : say('Wrote **src/a.js**.'),
  );
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
  const done = serveChat(io, () => Promise.resolve(0), { version: '9.9.9' });
  const send = (cmd: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  const states = (): ChatState[] => out.filter((o) => o.type === 'state') as unknown as ChatState[];
  const until = async <T>(fn: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { repo, send, out, states, until, stdin, done };
}

describe('omnexx chat-server (the VS Code chat panel protocol)', () => {
  it('chats, asks before a guarded command, counts tokens, and switches modes and approval', async () => {
    const t = await start();
    const ready = await t.until(() => t.out.find((o) => o.type === 'ready'), 'ready');
    expect(ready).toMatchObject({ version: '9.9.9' });

    t.send({ type: 'send', text: 'make a.js' });
    const asking = await t.until(
      () => t.states().find((s) => s.pending !== null),
      'approval question',
    );
    expect(asking.pending).toMatch(/sudo ls/);
    expect(asking.busy).toBe(true);
    t.send({ type: 'answer', yes: false });

    const last = await t.until(() => {
      const all = t.states().flatMap((s) => s.entries);
      return all.some((e) => e.text.includes('Wrote **src/a.js**.'))
        ? t.states().at(-1)
        : undefined;
    }, 'reply');
    expect(await readFile(join(t.repo, 'src/a.js'), 'utf8')).toContain('a = 1');
    const all = t.states().flatMap((s) => s.entries);
    expect(all.map((e) => e.text).join('\n')).toMatch(/refused: run `sudo ls`/);
    // Entries arrive once each, in order.
    const ids = all.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    const settled = await t.until(() => {
      const s = t.states().at(-1);
      return s && !s.busy && (s.usage?.turns ?? 0) > 0 ? s : undefined;
    }, 'idle state after the reply');
    expect(settled.usage?.turns).toBeGreaterThanOrEqual(3);
    expect(settled.usage?.tokens.output).toBeGreaterThan(0);
    expect(settled.usage?.toolCalls).toBeGreaterThanOrEqual(2);
    expect(settled.model).toMatch(/anthropic:/);
    expect(settled.context?.limit).toBeGreaterThan(0);
    expect(last).toBeDefined();

    t.send({ type: 'mode', mode: 'plan' });
    await t.until(() => t.states().find((s) => s.mode === 'plan'), 'plan mode');
    t.send({ type: 'yolo', on: true });
    await t.until(() => t.states().find((s) => s.autoApprove), 'auto-approve on');
    t.send({ type: 'yolo', on: true });
    t.send({ type: 'yolo', on: false });
    await t.until(() => t.states().at(-1)?.autoApprove === false || undefined, 'auto-approve off');

    t.send({ type: 'models' });
    const models = await t.until(() => t.out.find((o) => o.type === 'models'), 'model list');
    expect(models.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: 'anthropic:sonnet' })]),
    );

    const before = t.out.filter((o) => o.type === 'ready').length;
    t.send({ type: 'sync' });
    const resent = await t.until(() => {
      const readyAt = t.out.findLastIndex((o) => o.type === 'ready');
      if (t.out.filter((o) => o.type === 'ready').length <= before) return undefined;
      const s = t.out.slice(readyAt).find((o) => o.type === 'state') as ChatState | undefined;
      return s?.entries.some((e) => e.text === 'make a.js') ? s : undefined;
    }, 'full resend after sync');
    expect(resent.entries[0]?.id).toBe(0);

    // New chat: no "/clear" echo, a fresh panel, and the session totals start over.
    const readies = t.out.filter((o) => o.type === 'ready').length;
    t.send({ type: 'clear' });
    const fresh = await t.until(() => {
      const at = t.out.findLastIndex((o) => o.type === 'ready');
      if (t.out.filter((o) => o.type === 'ready').length <= readies) return undefined;
      return t.out.slice(at).findLast((o) => o.type === 'state') as ChatState | undefined;
    }, 'fresh state after clear');
    const afterClear = t.out.slice(t.out.findLastIndex((o) => o.type === 'ready'));
    const texts = afterClear
      .filter((o) => o.type === 'state')
      .flatMap((o) => (o as unknown as ChatState).entries.map((e) => e.text));
    expect(texts.some((x) => x.includes('/clear'))).toBe(false);
    expect(texts.some((x) => x.includes('make a.js'))).toBe(false);
    expect(fresh.usage?.turns ?? 0).toBe(0);
    expect(fresh.usage?.tokens.output ?? 0).toBe(0);
    expect(fresh.todos).toEqual([]);
    // A reloaded panel gets only what came after the clear.
    t.send({ type: 'sync' });
    await t.until(
      () => (t.out.filter((o) => o.type === 'ready').length > readies + 1 ? true : undefined),
      'sync after clear',
    );
    const synced = t.out.slice(t.out.findLastIndex((o) => o.type === 'ready'));
    const syncedTexts = synced
      .filter((o) => o.type === 'state')
      .flatMap((o) => (o as unknown as ChatState).entries.map((e) => e.text));
    expect(syncedTexts.some((x) => x.includes('make a.js'))).toBe(false);

    // Panel buttons don't echo as messages either.
    t.send({ type: 'compact' });
    await new Promise((r) => setTimeout(r, 200));
    const all2 = t.states().flatMap((x) => x.entries.map((e) => e.text));
    expect(all2.some((x) => ['/compact', '/clear', '/yolo'].includes(x))).toBe(false);

    // Model roles: saved to roles.json and read back.
    t.send({
      type: 'setRoles',
      roles: { models: { helpers: ['groq:a', 'cerebras:b', 'bad ref'] }, spreadHelpers: false },
    });
    const saved = await t.until(
      () =>
        t.out.findLast(
          (o) =>
            o.type === 'roles' &&
            (o.roles as { models: { helpers?: string[] } }).models.helpers?.length === 2,
        ),
      'saved roles',
    );
    expect(saved.roles).toEqual({
      models: { helpers: ['groq:a', 'cerebras:b'] },
      spreadHelpers: false,
    });
    expect(saved.exhausted).toEqual({});

    t.send({ type: 'nonsense' });
    await t.until(() => t.out.find((o) => o.type === 'error'), 'error for a bad command');
    t.stdin.write('not json\n');
    await t.until(
      () => t.out.filter((o) => o.type === 'error').length >= 2 || undefined,
      'bad json',
    );

    t.stdin.end();
    expect(await t.done).toBe(0);
  });
});
