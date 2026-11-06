import { fileExists, git, readJsonFile } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface ReviewComment {
  id?: string;
  file?: string;
  line?: number;
  body?: string;
  resolved?: boolean;
  author?: string;
}

/**
 * Reviews the daemon's own recent work for signs it went wrong: reverted
 * autonomous commits, autonomous commits whose messages admit a CI failure or
 * a follow-up fix, and unresolved review comments recorded locally.
 *
 * Each finding is bounded to ONE self-repair attempt per fingerprint: the
 * payload carries `maxSelfRepairAttempts: 1` so downstream stages never
 * loop on the same failure.
 */
export class SelfReviewCollector implements DiscoveryCollector {
  readonly name = 'self_review';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    findings.push(...(await this.collectReverts(repoRoot)));
    findings.push(...(await this.collectAutonomousFailures(repoRoot)));
    findings.push(...(await this.collectUnresolvedComments(repoRoot)));
    return findings;
  }

  /** Commits in the last 72h that revert an autonomous commit. */
  private async collectReverts(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const log = await git(repoRoot, [
      'log',
      '--since=72 hours ago',
      '--grep=^Revert',
      '--format=%H%x00%s%x00%b%x1e',
    ]);
    for (const entry of log.split('\x1e')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const [hash, subject, body] = trimmed.split('\x00');
      const reverted = /This reverts commit ([0-9a-f]{7,40})/.exec(body ?? '')?.[1];
      // Only care about reverts of autonomous work, or reverts whose subject names it.
      const autonomous =
        /omnexx-auto/i.test(subject ?? '') ||
        /omnexx-auto/i.test(body ?? '') ||
        (await this.isAutonomousCommit(repoRoot, reverted));
      if (!autonomous) continue;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `revert:${hash?.slice(0, 12) ?? 'unknown'}`,
          targetFiles: await this.commitFiles(repoRoot, hash ?? ''),
          severity: 0.85,
          confidence: 0.9,
          verification: 0.8,
          findingPayload: {
            kind: 'reverted-autonomous-commit',
            revertCommit: hash,
            revertedCommit: reverted ?? null,
            subject,
            maxSelfRepairAttempts: 1,
          },
        }),
      );
    }
    return findings;
  }

  /**
   * Autonomous commits in the last 72h whose own message admits trouble
   * (CI failure, follow-up fix, rollback) — the daemon's work needed repair.
   */
  private async collectAutonomousFailures(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const log = await git(repoRoot, [
      'log',
      '--since=72 hours ago',
      '--grep=omnexx-auto',
      '--format=%H%x00%s%x00%b%x1e',
    ]);
    const trouble = /(\bci (fail|broke|red)\b|follow-?up fix|hotfix|rollback|revert)/i;
    for (const entry of log.split('\x1e')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const [hash, subject, body] = trimmed.split('\x00');
      const text = `${subject ?? ''}\n${body ?? ''}`;
      if (!trouble.test(text)) continue;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `autonomous-trouble:${hash?.slice(0, 12) ?? 'unknown'}`,
          targetFiles: await this.commitFiles(repoRoot, hash ?? ''),
          severity: 0.85,
          confidence: 0.75,
          verification: 0.7,
          findingPayload: {
            kind: 'autonomous-commit-admits-failure',
            commit: hash,
            subject,
            maxSelfRepairAttempts: 1,
          },
        }),
      );
    }
    return findings;
  }

  /** Unresolved review comments recorded locally (no network, no GitHub API). */
  private async collectUnresolvedComments(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const path = `${repoRoot}/.omnexx/review-comments.json`;
    if (!fileExists(path)) return findings;
    const comments = (await readJsonFile<ReviewComment[]>(path)) ?? [];
    for (const comment of comments) {
      if (comment.resolved) continue;
      const id = comment.id ?? `${comment.file ?? 'unknown'}:${comment.line ?? 0}`;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `review-comment:${id}`,
          targetFiles: comment.file ? [comment.file] : [],
          severity: 0.85,
          confidence: 0.8,
          verification: 0.6,
          findingPayload: {
            kind: 'unresolved-review-comment',
            author: comment.author ?? null,
            line: comment.line ?? null,
            body: (comment.body ?? '').slice(0, 300),
            maxSelfRepairAttempts: 1,
          },
        }),
      );
    }
    return findings;
  }

  private async isAutonomousCommit(repoRoot: string, hash?: string): Promise<boolean> {
    if (!hash) return false;
    const subject = await git(repoRoot, ['log', '-1', '--format=%s%n%b', hash]);
    return /omnexx-auto/i.test(subject);
  }

  private async commitFiles(repoRoot: string, hash: string): Promise<string[]> {
    if (!hash) return [];
    const out = await git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', hash]);
    return out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  }
}
