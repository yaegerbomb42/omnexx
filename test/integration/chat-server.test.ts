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
  return { repo, send, out, states, until, stdin, done, provider };
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
      roles: {
        models: { helpers: ['groq:a', 'cerebras:b', 'bad ref'] },
        strategies: { helpers: 'random', worker: 'loud' },
        spreadHelpers: false,
      },
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
      strategies: { helpers: 'random' },
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

  it('lists, edits, deletes and resets context items, and the next request uses them', async () => {
    const t = await start();
    await t.until(() => t.out.find((o) => o.type === 'ready'), 'ready');
    t.send({ type: 'send', text: 'make a.js' });
    await t.until(() => t.states().find((s) => s.pending !== null), 'approval question');
    t.send({ type: 'answer', yes: false });
    await t.until(() => {
      const s = t.states().at(-1);
      return s && !s.busy && (s.usage?.turns ?? 0) > 0 ? s : undefined;
    }, 'idle after the reply');

    interface Item {
      id: string;
      group: string;
      text: string;
      removed: boolean;
      tokens: number;
    }
    const lastItems = (): Item[] | undefined =>
      t.out.findLast((o) => o.type === 'contextItems')?.items as Item[] | undefined;
    t.send({ type: 'contextList' });
    const items = await t.until(lastItems, 'context items');
    expect(items.map((i) => i.group)).toEqual(expect.arrayContaining(['system', 'tools', 'chat']));
    expect(items.find((i) => i.id === 'tool:bash')).toBeDefined();
    const chatCount = items.filter((i) => i.group === 'chat').length;

    const count = t.out.filter((o) => o.type === 'contextItems').length;
    t.send({ type: 'contextUpdate', id: 'system:0', text: 'EDITED SYSTEM' });
    t.send({ type: 'contextDelete', id: 'tool:bash' });
    t.send({ type: 'contextDelete', id: 'chat:0:0' });
    const edited = await t.until(
      () =>
        t.out.filter((o) => o.type === 'contextItems').length >= count + 3
          ? lastItems()
          : undefined,
      'edited items',
    );
    expect(edited.find((i) => i.id === 'system:0')?.text).toBe('EDITED SYSTEM');
    expect(edited.find((i) => i.id === 'tool:bash')?.removed).toBe(true);
    expect(edited.filter((i) => i.group === 'chat').length).toBe(chatCount - 1);

    const before = t.provider.requests.length;
    t.send({ type: 'send', text: 'again' });
    const req = await t.until(() => t.provider.requests[before], 'next request');
    expect(req.system[0]?.text).toBe('EDITED SYSTEM');
    expect(req.tools.map((x) => x.name)).not.toContain('bash');
    expect(JSON.stringify(req.messages)).not.toContain('make a.js');
    await t.until(() => (t.states().at(-1)?.busy === false ? true : undefined), 'idle again');

    t.send({ type: 'contextReset' });
    const reset = await t.until(() => {
      const it = lastItems();
      return it?.find((i) => i.id === 'tool:bash')?.removed === false ? it : undefined;
    }, 'reset items');
    expect(reset.find((i) => i.id === 'system:0')?.text).not.toBe('EDITED SYSTEM');

    // A note of your own and a pinned chat item go out with the next request, and the
    // inspector gets the budget to draw its bar against.
    t.send({ type: 'contextAdd', text: 'NOTE: use pnpm' });
    const firstChat = reset.find((i) => i.group === 'chat');
    t.send({ type: 'contextPin', id: firstChat?.id ?? 'chat:0:0' });
    const noted = await t.until(() => {
      const it = lastItems();
      return it?.filter((i) => i.group === 'notes').length === 2 ? it : undefined;
    }, 'notes');
    expect(noted.find((i) => i.id === 'note:1')?.text).toBe('NOTE: use pnpm');
    expect(t.out.findLast((o) => o.type === 'contextItems')?.budget).toBeGreaterThan(0);
    const beforeNote = t.provider.requests.length;
    t.send({ type: 'send', text: 'once more' });
    const noteReq = await t.until(() => t.provider.requests[beforeNote], 'request with notes');
    expect(noteReq.system.map((b) => b.text).join('\n')).toContain('NOTE: use pnpm');
    await t.until(() => (t.states().at(-1)?.busy === false ? true : undefined), 'idle after notes');

    t.send({ type: 'contextUpdate', id: 'nope', text: 'x' });
    await t.until(
      () => t.out.find((o) => o.type === 'error' && String(o.message).includes('no context item')),
      'error for an unknown id',
    );

    // History: the chat is listed by what was asked first, and reopening it shows its transcript.
    t.send({ type: 'clear' });
    t.send({ type: 'chats' });
    const listed = await t.until(
      () => t.out.findLast((o) => o.type === 'chats' && (o.chats as unknown[]).length > 0),
      'chat list',
    );
    const chat = (listed.chats as { id: string; title: string }[])[0];
    expect(chat?.title).toBe('Again');
    const readies = t.out.filter((o) => o.type === 'ready').length;
    t.send({ type: 'resumeChat', id: chat?.id });
    await t.until(() => {
      if (t.out.filter((o) => o.type === 'ready').length <= readies) return undefined;
      const texts = t.states().flatMap((s) => s.entries.map((e) => e.text));
      return texts.some((x) => x.startsWith('reopened "Again"')) ? true : undefined;
    }, 'reopened transcript');
    t.stdin.end();
    expect(await t.done).toBe(0);
  });
});
