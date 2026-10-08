import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import { commandDirs, expandCommand, loadCustomCommands } from '../../../src/tui/commands.js';
import { Session } from '../../../src/tui/session.js';
import { makeRepo } from '../../support/harness.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('custom slash commands', () => {
  it('loads .omnexx/commands over .claude/commands over your own, with descriptions', async () => {
    const repo = await tempDir();
    const home = await tempDir();
    const [own, claude, mine] = commandDirs(repo, home);
    for (const d of [own, claude, mine]) await mkdir(d ?? '', { recursive: true });
    await writeFile(
      join(own ?? '', 'review.md'),
      '---\ndescription: review the diff\n---\nReview the current diff for $ARGUMENTS.',
    );
    await writeFile(join(claude ?? '', 'review.md'), 'ignored: lower precedence');
    await writeFile(
      join(claude ?? '', 'changelog.md'),
      '# Write a changelog entry\nFor the last commit.',
    );
    await writeFile(join(mine ?? '', 'standup.md'), 'Summarize what changed today.');
    await writeFile(join(mine ?? '', 'Bad Name.md'), 'x');
    const cmds = await loadCustomCommands(commandDirs(repo, home));
    expect(cmds.map((c) => [c.name, c.description])).toEqual([
      ['review', 'review the diff'],
      ['changelog', 'Write a changelog entry'],
      ['standup', 'Summarize what changed today.'],
    ]);
    const review = cmds[0];
    if (!review) throw new Error('missing');
    expect(expandCommand(review, 'security')).toBe('Review the current diff for security.');
    const standup = cmds[2];
    if (!standup) throw new Error('missing');
    expect(expandCommand(standup, 'in the api')).toBe(
      'Summarize what changed today.\n\nin the api',
    );
  });

  it('shows in the menu and sends the expanded prompt to the agent', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, '.omnexx', 'commands'), { recursive: true });
    await writeFile(join(repo, '.omnexx', 'commands', 'explain.md'), 'Explain $ARGUMENTS simply.');
    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: await isolatedEnv(),
      cwd: repo,
      isTTY: false,
    } as CliIO;
    const s = new Session(io, () => Promise.resolve(0));
    await s.loadCommands();
    expect(s.complete('/ex').map((c) => c.name)).toEqual(['explain']);
    const sent: string[] = [];
    (s as unknown as { code_: (t: string) => Promise<void> }).code_ = (t) => {
      sent.push(t);
      return Promise.resolve();
    };
    await s.submit('/explain the plan file');
    expect(sent).toEqual(['Explain the plan file simply.']);
  });
});
