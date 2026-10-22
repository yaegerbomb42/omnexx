import { execa } from 'execa';
import { git } from '../git/git.js';

export interface SentinelCheck {
  pass: boolean;
  exitCode: number;
  timedOut: boolean;
  tail: string;
}

export interface SentinelResult {
  /** HEAD passed the full check. */
  healthy: boolean;
  /** First checkpoint whose tree fails, when bisection found one. */
  culprit?: string;
  /** SHA of the revert commit, when the culprit was reverted. */
  revertSha?: string;
  /** Why no revert happened, when unhealthy. */
  note?: string;
  /** Number of full-check invocations used. */
  probes: number;
}

/**
 * Binary search over an ordered list of commits for the first one where `isGood` is false.
 * Assumes `shas[goodIdx]` is good and `shas[badIdx]` is bad (goodIdx < badIdx).
 * Returns the index of the first bad commit. O(log n) probes.
 */
export async function firstBad(
  shas: readonly string[],
  isGood: (sha: string) => Promise<boolean>,
  goodIdx = 0,
  badIdx = shas.length - 1,
): Promise<number> {
  let lo = goodIdx;
  let hi = badIdx;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await isGood(shas[mid] ?? '')) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Run the full-check command in `cwd` through the shell. */
export async function runCheck(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<SentinelCheck> {
  const r = await execa(command, {
    cwd,
    shell: true,
    reject: false,
    timeout: timeoutMs,
    all: true,
    stdin: 'ignore',
  });
  const out = r.all.split('\n').slice(-20).join('\n');
  return {
    pass: r.exitCode === 0 && !r.timedOut,
    exitCode: r.exitCode ?? -1,
    timedOut: r.timedOut,
    tail: out,
  };
}

export interface SentinelOptions {
  cwd: string;
  /** Ordered checkpoint SHAs for this run, oldest first; index 0 is the run's start (assumed good). */
  history: readonly string[];
  /** Probe one commit; defaults to `runCheck` with `command`. */
  check: (cwd: string) => Promise<SentinelCheck>;
  autoRevert: boolean;
}

/**
 * Check HEAD; on failure, bisect `history` to the first bad checkpoint and optionally revert it.
 * The worktree must be clean. HEAD is restored to the original branch tip before reverting.
 */
export async function runSentinel(opts: SentinelOptions): Promise<SentinelResult> {
  const { cwd, history } = opts;
  let probes = 1;
  const head = await opts.check(cwd);
  if (head.pass) return { healthy: true, probes };
  if (history.length < 2) {
    return { healthy: false, probes, note: 'no checkpoints to bisect' };
  }
  const branch = (
    await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  ).stdout.trim();
  const tip = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  const restore = branch && branch !== 'HEAD' ? branch : tip;

  let startGood: boolean;
  let idx: number;
  try {
    // Confirm the start is good; if not, the failure predates this run and is not ours to revert.
    await git(cwd, ['checkout', '-q', '--detach', history[0] ?? '']);
    probes++;
    startGood = (await opts.check(cwd)).pass;
    idx = startGood
      ? await firstBad(history, async (sha) => {
          await git(cwd, ['checkout', '-q', '--detach', sha]);
          probes++;
          return (await opts.check(cwd)).pass;
        })
      : -1;
  } finally {
    await git(cwd, ['checkout', '-q', restore]);
  }
  if (!startGood) {
    return { healthy: false, probes, note: 'run start already fails the check; not reverting' };
  }
  const culprit = history[idx] ?? '';
  if (!opts.autoRevert) return { healthy: false, culprit, probes, note: 'auto_revert is off' };

  // Reverse-apply the culprit's diff instead of `git revert`: no merge machinery, so a
  // conflicting revert fails fast (user merge drivers/tools can't block an unattended run).
  const diff = await git(cwd, ['diff', '--binary', `${culprit}^`, culprit]);
  const rev = await git(cwd, ['apply', '-R', '--index', '-'], {
    input: `${diff.stdout}\n`,
    allowFailure: true,
  });
  if (rev.exitCode !== 0) {
    await git(cwd, ['reset', '-q', '--hard', 'HEAD'], { allowFailure: true });
    return { healthy: false, culprit, probes, note: 'revert conflicted; left for the agent' };
  }
  const subject = (await git(cwd, ['log', '-1', '--format=%s', culprit])).stdout.trim();
  await git(
    cwd,
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-verify',
      '-q',
      '-F',
      '-',
    ],
    { input: `Revert "${subject}"\n\nomnexx sentinel: full check regressed at ${culprit}.\n` },
  );
  const revertSha = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  return { healthy: false, culprit, revertSha, probes };
}
