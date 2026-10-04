import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { git } from '../../src/git/git.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fresh directory under os.tmpdir(), removed after the test. Realpath'd (macOS /var → /private/var). */
export async function tempDir(prefix = 'omnexx-test-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** A git repo with a local identity, so nothing reads or writes global git config. */
export async function tempRepo(): Promise<string> {
  const dir = await tempDir('omnexx-repo-');
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Omnexx Test']);
  await git(dir, ['config', 'user.email', 'test@omnexx.invalid']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/** Env for code under test: isolated OMNEXX_HOME / OMNEXX_CONFIG_HOME and no inherited keys. */
export async function isolatedEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const home = await tempDir('omnexx-home-');
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OMNEXX_HOME: join(home, 'state'),
    OMNEXX_CONFIG_HOME: join(home, 'config'),
    ...extra,
  };
}
