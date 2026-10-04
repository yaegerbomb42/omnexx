import { git } from './git.js';
import { headSha } from './repo.js';
import { formatTrailers, type OmnexxTrailers } from './trailers.js';

/** Settings that keep an unattended commit from hanging or running user code. */
const SAFE = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

async function identity(cwd: string): Promise<string[]> {
  const email = await git(cwd, ['config', 'user.email'], { allowFailure: true });
  return email.stdout.trim()
    ? []
    : ['-c', 'user.name=omnexx', '-c', 'user.email=omnexx@users.noreply.invalid'];
}

/** Stage everything and commit with Omnexx trailers. Returns the new SHA. */
export async function commitCheckpoint(
  cwd: string,
  subject: string,
  body: string,
  trailers: OmnexxTrailers,
): Promise<string> {
  await git(cwd, ['add', '-A']);
  const message = `${subject}\n\n${body.trim() ? `${body.trim()}\n\n` : ''}${formatTrailers(trailers)}\n`;
  await git(cwd, [...SAFE, ...(await identity(cwd)), 'commit', '--no-verify', '-q', '-F', '-'], {
    input: message,
  });
  return headSha(cwd);
}

export async function tagCheckpoint(cwd: string, tag: string, sha: string): Promise<void> {
  await git(cwd, ['tag', '-f', tag, sha]);
}
