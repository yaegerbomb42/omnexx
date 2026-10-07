import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../src/cli/io.js';
import { createRun } from '../../src/core/create.js';
import type { Note } from '../../src/core/notes.js';
import { resolvePaths } from '../../src/core/paths.js';
import {
  mergeNotes,
  readRepoNotes,
  repoMemoryFile,
  saveToRepoMemory,
} from '../../src/core/repo-memory.js';
import { RunStore } from '../../src/core/run-store.js';
import { git } from '../../src/git/git.js';
import type { CompletionRequest, Provider } from '../../src/providers/types.js';
import { emptyUsage } from '../../src/providers/types.js';
import { Session } from '../../src/tui/session.js';
import { makeRepo } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

const note = (
  id: string,
  text: string,
  type: Note['type'] = 'pitfall',
  date = '2026-10-01',
): Note => ({ id, type, text, date });

describe('repo memory', () => {
  it('merges without duplicates and, when full, drops the oldest non-env lessons first', () => {
    const merged = mergeNotes(
      [note('N1', 'use pnpm', 'command')],
      [note('N1', 'Use  PNPM', 'command'), note('N2', 'tests need DB_URL', 'env')],
      10_000,
    );
    expect(merged.map((n) => [n.id, n.text])).toEqual([
      ['N1', 'use pnpm'],
      ['N2', 'tests need DB_URL'],
    ]);
    const full = mergeNotes(
      [
        note('N1', 'old pitfall '.repeat(10), 'pitfall', '2026-01-01'),
        note('N2', 'keep env '.repeat(10), 'env', '2025-01-01'),
      ],
      [note('N1', 'new convention '.repeat(10), 'convention', '2026-10-01')],
      100,
    );
    expect(full.some((n) => n.text.startsWith('old pitfall'))).toBe(false);
    expect(full.some((n) => n.type === 'env')).toBe(true);
  });

  it('keys by the origin remote, so two clones share memory', async () => {
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    const a = await makeRepo();
    const b = await makeRepo();
    for (const r of [a, b]) await git(r, ['remote', 'add', 'origin', 'git@github.com:me/app.git']);
    expect(await repoMemoryFile(paths, a)).not.toBe(await repoMemoryFile(paths, await makeRepo()));
    expect((await repoMemoryFile(paths, a)).split('-').pop()).toBe(
      (await repoMemoryFile(paths, b)).split('-').pop(),
    );
  });

  it('a new run starts with what earlier runs learned', async () => {
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    const repo = await makeRepo();
    await saveToRepoMemory(
      paths,
      repo,
      [note('N1', 'run tests with node --test', 'command')],
      1_500,
    );
    const store = await createRun({ paths, cwd: repo, goal: 'g', now: Date.now() });
    expect((await store.readNotes()).map((n) => n.text)).toEqual(['run tests with node --test']);
    expect(store).toBeInstanceOf(RunStore);
  });

  it('a lesson remembered in chat is there for the next chat', async () => {
    const repo = await makeRepo();
    const env = await isolatedEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000' });
    let calls = 0;
    const provider: Provider = {
      name: 'anthropic',
      complete(req: CompletionRequest) {
        calls++;
        const content =
          calls === 1
            ? [
                {
                  type: 'tool_use' as const,
                  id: 'r',
                  name: 'remember',
                  input: { action: 'add', type: 'convention', text: 'prefer named exports' },
                },
              ]
            : [{ type: 'text' as const, text: 'noted' }];
        return Promise.resolve({
          content,
          stopReason: calls === 1 ? 'tool_use' : 'end_turn',
          usage: emptyUsage(),
          model: req.model,
        });
      },
    };
    const io = (): CliIO => ({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: repo,
      isTTY: false,
      makeProvider: () => provider,
    });
    await new Session(io(), () => Promise.resolve(0)).submit('remember: we prefer named exports');
    expect((await readRepoNotes(resolvePaths(env), repo)).map((n) => n.text)).toEqual([
      'prefer named exports',
    ]);
    const seen: string[] = [];
    const second: Provider = {
      name: 'anthropic',
      complete(req) {
        seen.push(req.system.map((b) => b.text).join('\n'));
        return Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: emptyUsage(),
          model: req.model,
        });
      },
    };
    await new Session({ ...io(), makeProvider: () => second }, () => Promise.resolve(0)).submit(
      'hi',
    );
    expect(seen[0]).toContain('prefer named exports');
  });
});
