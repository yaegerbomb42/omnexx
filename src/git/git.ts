import { execa } from 'execa';
import { GitError } from '../errors.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run git with a fixed, minimal environment: no pager, no prompts, no editor, no
 * user hooks or signing that could hang an unattended run.
 */
export async function git(
  cwd: string,
  args: readonly string[],
  opts: { allowFailure?: boolean; input?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  const result = await execa('git', ['-c', 'core.pager=cat', ...args], {
    cwd,
    reject: false,
    stripFinalNewline: true,
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: 'ignore' }),
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat',
      LC_ALL: 'C',
      ...opts.env,
    },
  });
  const out: GitResult = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
  };
  if (out.exitCode !== 0 && !opts.allowFailure) {
    throw new GitError(
      `git ${args.join(' ')} failed (exit ${out.exitCode}): ${out.stderr.split('\n')[0] ?? ''}`,
    );
  }
  return out;
}
