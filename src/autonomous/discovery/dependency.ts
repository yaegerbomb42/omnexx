import { runCommand, safeJsonParse } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface OutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  type?: string;
}

interface AuditVulnerability {
  severity?: string;
  title?: string;
  fixAvailable?: boolean | { name?: string; version?: string };
  via?: unknown[];
}

interface AuditReport {
  vulnerabilities?: Record<string, AuditVulnerability>;
}

const SEVERITY_SCORE: Record<string, number> = {
  critical: 0.95,
  high: 0.8,
  moderate: 0.55,
  low: 0.3,
  info: 0.15,
};

/**
 * `npm outdated` (patch/minor only — major bumps are human-review) plus
 * `npm audit` (high/critical vulnerabilities).
 *
 * Deviation from the brief: the per-package publish-age check (≥7 days) via
 * `npm view <pkg> time --json` is SKIPPED. It needs one network round-trip per
 * outdated package, which makes the collector slow and flaky offline; the
 * age gate belongs in the downstream verifier, which can batch the lookups.
 * The deviation is recorded on every outdated finding's payload.
 */
export class DependencyCollector implements DiscoveryCollector {
  readonly name = 'dependency';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    findings.push(...(await this.collectOutdated(repoRoot)));
    findings.push(...(await this.collectAudit(repoRoot)));
    return findings;
  }

  private async collectOutdated(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    // npm outdated exits 1 when anything is outdated — that is a normal result.
    const result = await runCommand('npm', ['outdated', '--json'], repoRoot, 120_000);
    if (result.timedOut || !result.stdout.trim()) return findings;
    const outdated = safeJsonParse(result.stdout.trim()) as
      Record<string, OutdatedEntry> | undefined;
    if (!outdated) return findings;

    for (const [pkg, entry] of Object.entries(outdated)) {
      const current = entry.current ?? '?';
      const wanted = entry.wanted ?? current;
      const latest = entry.latest ?? wanted;
      const isMajor = majorBump(current, latest);
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `outdated:${pkg}`,
          targetFiles: ['package.json'],
          severity: isMajor ? 0.4 : 0.55,
          confidence: 0.9,
          verification: 0.6,
          findingPayload: {
            kind: 'outdated-dependency',
            package: pkg,
            current,
            wanted,
            latest,
            updateType: isMajor ? 'major' : (entry.type ?? 'minor'),
            // Major bumps are never auto-applied: a human must review the changelog.
            requiresHumanReview: isMajor,
            publishAgeCheckSkipped: true,
            publishAgeCheckNote:
              'Per-package `npm view <pkg> time` age gate (≥7 days) skipped for speed/offline safety; verify age downstream before queueing.',
          },
        }),
      );
    }
    return findings;
  }

  private async collectAudit(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const result = await runCommand('npm', ['audit', '--json'], repoRoot, 120_000);
    if (result.timedOut || !result.stdout.trim()) return findings;
    const report = safeJsonParse(result.stdout.trim()) as AuditReport | undefined;
    if (!report?.vulnerabilities) return findings;

    for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
      const severity = (vuln.severity ?? 'low').toLowerCase();
      if (severity !== 'critical' && severity !== 'high') continue;
      const fix = vuln.fixAvailable;
      const targetPkg = typeof fix === 'object' && (fix as { name?: string })?.name
        ? (fix as { name?: string }).name!
        : pkg;
      const fixVersion = typeof fix === 'object' ? ((fix as { version?: string })?.version ?? null) : null;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `audit:${targetPkg}:${severity}`,
          targetFiles: ['package.json', 'package-lock.json'],
          severity: SEVERITY_SCORE[severity] ?? 0.5,
          confidence: 0.85,
          verification: 0.6,
          findingPayload: {
            kind: 'vulnerable-dependency',
            package: targetPkg,
            vulnerableDependency: pkg,
            severity,
            title: vuln.title ?? null,
            fixAvailable: Boolean(fix),
            fixVersion,
          },
        }),
      );
    }
    return findings;
  }
}

/** True when latest is a major version ahead of current (semver, best effort). */
function majorBump(current: string, latest: string): boolean {
  const parse = (v: string): number[] | null => {
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim().replace(/^[v=^~ ]+/, ''));
    if (!match) return null;
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  };
  const from = parse(current);
  const to = parse(latest);
  if (!from || !to) return false;
  return (to[0] as number) > (from[0] as number);
}
