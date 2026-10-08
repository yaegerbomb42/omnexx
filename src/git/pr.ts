import { execa } from 'execa';
import { readTextOr } from '../core/atomic.js';
import type { Run } from '../core/run.js';
import { git } from './git.js';

/** GitHub rejects bodies over 65,536 characters. */
const MAX_BODY = 60_000;

async function gh(
  cwd: string,
  args: string[],
  input?: string,
): Promise<{ ok: boolean; out: string }> {
  const r = await execa('gh', args, {
    cwd,
    reject: false,
    ...(input !== undefined ? { input } : { stdin: 'ignore' }),
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: (err as Error).message }));
  return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim() };
}

/**
 * `[git] open_pr`: push the run's branch and open a PR (with `gh`), titled from the goal, with the
 * morning-after report as its body. Idempotent: a resumed or re-finished run reuses its PR.
 * Returns the PR URL, or undefined (nothing to propose, or it couldn't be opened: see events).
 */
export async function openPullRequest(run: Run): Promise<string | undefined> {
  const s = run.state;
  if (s.prUrl) return s.prUrl;
  if (!s.acceptedCommits) return undefined;
  const remote = run.config.git.remote;
  const push = await git(run.worktree, ['push', '-q', remote, `${s.branch}:${s.branch}`], {
    allowFailure: true,
  });
  if (push.exitCode !== 0) {
    run.events.emit('pr.failed', { step: 'push', error: push.stderr.slice(0, 300) });
    return undefined;
  }
  const existing = await gh(s.repoRoot, ['pr', 'view', s.branch, '--json', 'url', '--jq', '.url']);
  let url =
    existing.ok && /^https?:\/\//.test(existing.out) ? existing.out.split('\n')[0] : undefined;
  if (!url) {
    const head = (
      await git(s.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
    ).stdout.trim();
    const base =
      run.config.git.pr_base ?? (head && head !== 'HEAD' && head !== s.branch ? head : undefined);
    const goal =
      (await run.store.readGoal()).text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ??
      'omnexx run';
    const report = await readTextOr(run.store.file('REPORT.md'), '');
    const body = `${report.slice(0, MAX_BODY)}\n\n---\nOpened by omnexx run \`${s.runId}\`.`;
    const created = await gh(
      s.repoRoot,
      [
        'pr',
        'create',
        '--head',
        s.branch,
        ...(base ? ['--base', base] : []),
        '--title',
        `omnexx: ${goal.trim().slice(0, 100)}`,
        '--body-file',
        '-',
      ],
      body,
    );
    url = created.out
      .split('\n')
      .find((l) => /^https?:\/\/\S+\/pull\/\d+/.test(l.trim()))
      ?.trim();
    if (!created.ok || !url) {
      run.events.emit('pr.failed', { step: 'create', error: created.out.slice(0, 300) });
      return undefined;
    }
  }
  s.prUrl = url;
  await run.save();
  run.events.emit('pr.opened', { url });
  return url;
}
