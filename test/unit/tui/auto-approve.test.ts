import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { resolvePaths, userConfigFile } from '../../../src/core/paths.js';
import { Session } from '../../../src/tui/session.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

describe('auto-approve', () => {
  it('policy.auto_approve answers guard questions with yes; /yolo toggles it', async () => {
    const env = await isolatedEnv();
    const file = userConfigFile(resolvePaths(env));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '[policy]\nauto_approve = true\n');
    const io = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: await tempDir(),
      isTTY: false,
    } as never;
    const s = new Session(io, () => Promise.resolve(0));
    await s.greet();
    expect(await s.ask('run `git -C . status`? [y/N]')).toBe(true);
    expect(s.entries.at(-1)?.text).toMatch(/auto-approved: run `git -C \. status`\?$/);
    await s.slash('yolo');
    let answered = false;
    void s.ask('again? [y/N]').then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    expect(s.pending?.question).toMatch(/again/);
  });
});
