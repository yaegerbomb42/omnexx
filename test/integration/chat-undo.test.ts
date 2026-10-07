import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import type { CompletionRequest, ContentBlock, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { restoreTree, snapshotTree } from '../../src/tui/undo.js';
import { Session } from '../../src/tui/session.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';
import { git } from '../../src/git/git.js';

/** Turn 0 of every message: edit a.txt, create made.txt, delete gone.txt; then answer. */
function editor(seen: CompletionRequest[]): Provider {
  return {
    name: 'anthropic',
    complete(req) {
      seen.push({ ...req, messages: structuredClone(req.messages) });
      const last = req.messages.at(-1);
      const fresh = last?.role === 'user' && last.content.some((b) => b.type === 'text');
      const content: ContentBlock[] = fresh
        ? [
            {
              type: 'tool_use',
              id: 'w1',
              name: 'write_file',
              input: { path: 'a.txt', content: 'changed\n' },
            },
            {
              type: 'tool_use',
              id: 'w2',
              name: 'write_file',
              input: { path: 'made.txt', content: 'new\n' },
            },
            { type: 'tool_use', id: 'w3', name: 'bash', input: { command: 'rm gone.txt' } },
          ]
        : [{ type: 'text', text: 'done' }];
      return Promise.resolve({
        content,
        stopReason: fresh ? 'tool_use' : 'end_turn',
        usage: emptyUsage(),
        model: req.model,
      });
    },
  };
}

describe('chat undo and continue', () => {
  it('snapshots never touch the index; restore undoes edits, creations and deletions', async () => {
    const repo = await makeRepo({ 'a.txt': 'one\n', 'gone.txt': 'bye\n' });
    await writeFile(join(repo, 'untracked.txt'), 'u\n');
    const tree = await snapshotTree(repo);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(repo, ['status', '--porcelain'])).stdout.trim()).toBe('?? untracked.txt');
    await writeFile(join(repo, 'a.txt'), 'two\n');
    await writeFile(join(repo, 'x.txt'), 'x\n');
    await git(repo, ['rm', '-q', 'gone.txt']);
    const touched = await restoreTree(repo, tree ?? '');
    expect(touched.sort()).toEqual(['a.txt', 'gone.txt', 'x.txt']);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(repo, 'x.txt'))).toBe(false);
    expect(await readFile(join(repo, 'gone.txt'), 'utf8')).toBe('bye\n');
    expect(await snapshotTree(await (await import('../support/tmp.js')).tempDir())).toBeUndefined();
  });

  it('/undo restores the files and drops the exchange; --continue picks the chat up later', async () => {
    const repo = await makeRepo({ 'a.txt': 'one\n', 'gone.txt': 'bye\n' });
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
    const seen: CompletionRequest[] = [];
    const io = (): CliIO => ({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: repo,
      isTTY: false,
      makeProvider: () => editor(seen),
    });
    const s = new Session(io(), () => Promise.resolve(0));
    await s.submit('first');
    await s.submit('second');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('changed\n');
    await s.submit('/undo');
    expect(s.entries.at(-1)?.text).toMatch(/undone: no files had changed/);
    await s.submit('/undo');
    expect(s.entries.at(-1)?.text).toMatch(/undone: restored 3 files/);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(repo, 'made.txt'))).toBe(false);
    expect(existsSync(join(repo, 'gone.txt'))).toBe(true);
    await s.submit('/undo');
    expect(s.entries.at(-1)?.text).toBe('nothing to undo');

    await s.submit('kept message');
    seen.length = 0;
    const later = new Session(io(), () => Promise.resolve(0));
    await later.continueChat();
    expect(later.entries.at(-1)?.text).toMatch(/continuing your last chat here \(1 message\)/);
    await later.submit('and then?');
    const firstUser = seen[0]?.messages[0]?.content[0];
    expect(firstUser?.type === 'text' && firstUser.text).toBe('kept message');
  });
});
