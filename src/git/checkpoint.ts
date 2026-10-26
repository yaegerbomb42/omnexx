import { git } from './git.js';
import { headSha, stageAll } from './repo.js';
import { formatTrailers, type OmnexxTrailers } from './trailers.js';

/** Settings that keep an unattended commit from hanging or running user code. */
const SAFE = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

async function identity(cwd: string): Promise<string[]> {
  const [name, email] = await Promise.all([
    git(cwd, ['config', 'user.name'], { allowFailure: true }),
    git(cwd, ['config', 'user.email'], { allowFailure: true }),
  ]);
  const overrides: string[] = [];
  if (!name.stdout.trim()) overrides.push('-c', 'user.name=omnexx');
  if (!email.stdout.trim()) overrides.push('-c', 'user.email=omnexx@users.noreply.invalid');
  return overrides;
}

/** Stage everything and commit with Omnexx trailers. Returns the new SHA. */
export async function commitCheckpoint(
  cwd: string,
  subject: string,
  body: string,
  trailers: OmnexxTrailers,
): Promise<string> {
  await stageAll(cwd, 'HEAD');
  const message = `${subject}\n\n${body.trim() ? `${body.trim()}\n\n` : ''}${formatTrailers(trailers)}\n`;
  await git(cwd, [...SAFE, ...(await identity(cwd)), 'commit', '--no-verify', '-q', '-F', '-'], {
    input: message,
  });
  return headSha(cwd);
}

export async function tagCheckpoint(cwd: string, tag: string, sha: string): Promise<void> {
  await git(cwd, ['tag', '-f', tag, sha]);
}
