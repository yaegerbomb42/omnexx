import { execa } from 'execa';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../core/atomic.js';
import { git } from '../git/git.js';
import { workingTreeDiff } from '../git/repo.js';

/**
 * Shipping controller for the 24/7 autonomous daemon.
 *
 * Every finished task is scored and shipped by risk tier. Nothing here touches the user's
 * primary checkout: Tier 1 fast-forwards the autonomous branch by pushing the worktree's
 * HEAD to it (a push is fast-forward-only by default, so a non-FF target falls back to a
 * PR instead of forcing anything), and Tiers 2/3 open pull requests from a pushed branch.
 */

export type ChangeCategory =
  'test-only' | 'dead-code' | 'lint-fix' | 'bug-fix' | 'dep-update' | 'refactor' | 'public-api';

/**
 * Base risk by change category. A bug fix only earns the low 10 when it carries Stage-3
 * revert proof; without proof it is scored as a 25 like any other multi-file change.
 */
export function categoryBaseRisk(category: ChangeCategory, revertProof = false): number {
  switch (category) {
    case 'test-only':
    case 'dead-code':
    case 'lint-fix':
      return 0;
    case 'bug-fix':
      return revertProof ? 10 : 25;
    case 'dep-update':
    case 'refactor':
      return 25;
    case 'public-api':
      return 60;
  }
}

export interface RiskInputs {
  filesChanged: number;
  /** Added + removed lines. */
  netLoCChanged: number;
  /** Most imports any single changed file receives from elsewhere in the repo. */
  maxInboundImports: number;
  category: ChangeCategory;
  /** Stage-3 revert proof present (only matters for `bug-fix`). */
  revertProof?: boolean;
}

export interface RiskScore {
  score: number;
  tier: 1 | 2 | 3;
  breakdown: { files: number; loc: number; imports: number; category: number };
}

/** RiskScore = (FilesChanged * 5) + (NetLoCChanged * 0.3) + (MaxInboundImports * 2.5) + CategoryBaseRisk. */
export function computeRiskScore(input: RiskInputs): RiskScore {
  const files = input.filesChanged * 5;
  const loc = input.netLoCChanged * 0.3;
  const imports = input.maxInboundImports * 2.5;
  const category = categoryBaseRisk(input.category, input.revertProof);
  const score = files + loc + imports + category;
  const tier: 1 | 2 | 3 = score <= 25 ? 1 : score <= 55 ? 2 : 3;
  return { score, tier, breakdown: { files, loc, imports, category } };
}

/**
 * Diff stats for a finished task, collected from the worktree against its base.
 * `maxInboundImports` is caller-supplied (a repo-wide import scan); default 0.
 */
export async function collectChangeStats(
  worktreePath: string,
  baseSha: string,
  maxInboundImports = 0,
): Promise<Omit<RiskInputs, 'category' | 'revertProof'>> {
  const diff = await workingTreeDiff(worktreePath, baseSha);
  const netLoCChanged = diff.changes.reduce((s, c) => s + c.added + c.removed, 0);
  return { filesChanged: diff.changes.length, netLoCChanged, maxInboundImports };
}

export interface ShipTask extends RiskInputs {
  taskId: string;
  worktreePath: string;
  baseSha: string;
  title: string;
  /** Verification receipt (gates, tests) pasted into the PR body. */
  verificationReceipt: string;
}

export interface ReviewQueueEntry {
  taskId: string;
  tier: 1 | 2 | 3;
  riskScore: number;
  branch: string;
  prUrl?: string | undefined;
  needsHumanApproval: boolean;
  createdAt: number;
}

export interface ShipResult {
  taskId: string;
  tier: 1 | 2 | 3;
  riskScore: number;
  branch: string;
  merged: boolean;
  prUrl?: string | undefined;
  /** Written when `gh` is unavailable: the PR body for a human to open by hand. */
  prBodyPath?: string | undefined;
  needsHumanApproval: boolean;
  /** Set when the run fell back because `gh` (or the push) was unavailable. */
  note?: string | undefined;
}

export interface ShippingControllerOptions {
  repoRoot: string;
  /** Branch Tier 1 fast-forwards to. Defaults to `omnexx/auto-main`. */
  targetBranch?: string;
  /** Remote to push to. Defaults to `origin`. */
  remote?: string;
  /** Where the VS Code review queue lives. Defaults to `<repoRoot>/.omnexx/review-queue.json`. */
  reviewQueuePath?: string;
  /** Where PR bodies go when `gh` is absent. Defaults to `<repoRoot>/.omnexx/pr-bodies`. */
  prBodiesDir?: string;
  /** Injectable `gh` availability check (default: `gh --version`). */
  ghAvailable?: () => Promise<boolean>;
  /** Injectable `gh` runner (default: execa). */
  runGh?: (args: string[], input?: string) => Promise<{ ok: boolean; out: string }>;
  now?: () => number;
}

async function defaultGhAvailable(): Promise<boolean> {
  const r = await execa('gh', ['--version'], { reject: false }).catch(() => undefined);
  return r?.exitCode === 0;
}

async function defaultRunGh(args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  const r = await execa('gh', args, {
    reject: false,
    ...(input !== undefined ? { input } : { stdin: 'ignore' }),
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: (err as Error).message }));
  return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim() };
}

export class ShippingController {
  private readonly targetBranch: string;
  private readonly remote: string;
  private readonly reviewQueuePath: string;
  private readonly prBodiesDir: string;
  private readonly ghAvailable: () => Promise<boolean>;
  private readonly runGh: (args: string[], input?: string) => Promise<{ ok: boolean; out: string }>;
  private readonly now: () => number;

  constructor(options: ShippingControllerOptions) {
    this.targetBranch = options.targetBranch ?? 'omnexx/auto-main';
    this.remote = options.remote ?? 'origin';
    this.reviewQueuePath =
      options.reviewQueuePath ?? join(options.repoRoot, '.omnexx', 'review-queue.json');
    this.prBodiesDir = options.prBodiesDir ?? join(options.repoRoot, '.omnexx', 'pr-bodies');
    this.ghAvailable = options.ghAvailable ?? defaultGhAvailable;
    this.runGh = options.runGh ?? defaultRunGh;
    this.now = options.now ?? Date.now;
  }

  async ship(task: ShipTask): Promise<ShipResult> {
    const risk = computeRiskScore(task);
    const branch = `omnexx/auto/${task.taskId}`;
    const base: ShipResult = {
      taskId: task.taskId,
      tier: risk.tier,
      riskScore: risk.score,
      branch,
      merged: false,
      needsHumanApproval: risk.tier === 3,
    };

    if (risk.tier === 1) {
      // Fast-forward-only push of the worktree HEAD onto the autonomous branch.
      // A non-FF target is rejected by the server, never forced: fall back to a PR.
      // The destination must be fully qualified (refs/heads/...): the source
      // here is a raw commit SHA, and git refuses an unqualified destination
      // for a SHA source ("not a full refname").
      const head = (await git(task.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
      const push = await git(
        task.worktreePath,
        ['push', '-q', this.remote, `${head}:refs/heads/${this.targetBranch}`],
        { allowFailure: true },
      );
      if (push.exitCode === 0) return { ...base, merged: true };
      // Non-FF (or unreachable remote): ship as a Tier 2 PR instead.
      return this.openPr({ ...base, tier: 2 }, task, branch);
    }
    return this.openPr(base, task, branch);
  }

  private async openPr(base: ShipResult, task: ShipTask, branch: string): Promise<ShipResult> {
    const head = (await git(task.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    // Fully-qualified destination: the source is a raw SHA (see Tier 1 above).
    const push = await git(
      task.worktreePath,
      ['push', '-q', this.remote, `${head}:refs/heads/${branch}`],
      {
        allowFailure: true,
      },
    );
    const body = this.prBody(task, base);
    if (push.exitCode !== 0) {
      // Cannot even push the branch: leave the PR body on disk for a human.
      const prBodyPath = await this.writePrBody(task.taskId, body);
      return {
        ...base,
        prBodyPath,
        note: `branch push failed (${push.stderr.trim().slice(0, 200)}); branch + PR body left on disk`,
      };
    }
    if (!(await this.ghAvailable())) {
      const prBodyPath = await this.writePrBody(task.taskId, body);
      await this.enqueue({ ...base, prBodyPath });
      return {
        ...base,
        prBodyPath,
        note: 'gh CLI unavailable; branch pushed, PR body written to disk',
      };
    }
    const args = [
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      this.targetBranch,
      '--title',
      task.title,
      '--body-file',
      '-',
      ...(base.tier === 3 ? ['--draft'] : []),
    ];
    const created = await this.runGh(args, body);
    const prUrl = created.out
      .split('\n')
      .find((l) => /^https?:\/\/\S+\/pull\/\d+/.test(l.trim()))
      ?.trim();
    if (!created.ok || !prUrl) {
      const prBodyPath = await this.writePrBody(task.taskId, body);
      await this.enqueue({ ...base, prBodyPath });
      return {
        ...base,
        prBodyPath,
        note: `gh pr create failed (${created.out.slice(0, 200)}); PR body written to disk`,
      };
    }
    const result: ShipResult = { ...base, prUrl };
    await this.enqueue(result);
    return result;
  }

  private prBody(task: ShipTask, result: ShipResult): string {
    const flag =
      result.tier === 3
        ? '\n\n**NEEDS_HUMAN_APPROVAL** — Tier 3 (risk > 55); do not merge without review.'
        : '';
    return [
      `## omnexx autonomous task ${task.taskId}`,
      '',
      `Risk score: ${result.riskScore.toFixed(1)} (Tier ${result.tier}) — ${task.filesChanged} files, ${task.netLoCChanged} net LoC, category ${task.category}.`,
      '',
      '### Verification receipt',
      '',
      task.verificationReceipt,
      flag,
    ].join('\n');
  }

  private async writePrBody(taskId: string, body: string): Promise<string> {
    await mkdir(this.prBodiesDir, { recursive: true });
    const path = join(this.prBodiesDir, `${taskId}.md`);
    await writeFile(path, body, 'utf8');
    return path;
  }

  /** Append an entry to the VS Code review queue (`.omnexx/review-queue.json`). */
  async enqueue(result: ShipResult): Promise<void> {
    let queue: ReviewQueueEntry[] = [];
    try {
      const raw = await readFile(this.reviewQueuePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) queue = parsed as ReviewQueueEntry[];
    } catch {
      queue = [];
    }
    queue = queue.filter((e) => e.taskId !== result.taskId);
    queue.push({
      taskId: result.taskId,
      tier: result.tier,
      riskScore: result.riskScore,
      branch: result.branch,
      ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      needsHumanApproval: result.needsHumanApproval,
      createdAt: this.now(),
    });
    await mkdir(dirname(this.reviewQueuePath), { recursive: true });
    await writeJsonAtomic(this.reviewQueuePath, queue);
  }
}
