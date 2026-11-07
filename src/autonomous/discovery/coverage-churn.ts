import { git, parseNumstat, readJsonFile } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface CoverageFileSummary {
  lines?: { pct?: number };
  branches?: { pct?: number };
}

interface CoverageSummary {
  total?: CoverageFileSummary;
  [file: string]: CoverageFileSummary | undefined;
}

/** Minimum churn (added + deleted lines in 30 days) for a file to count as high-churn. */
const HIGH_CHURN_LINES = 20;
/** Only files below this line-coverage pct are worth queueing. */
const LOW_COVERAGE_PCT = 100;

/**
 * Intersects uncovered lines with recent churn: only uncovered code in
 * high-churn core files (src/**) is queued. Needs a coverage summary
 * (coverage/coverage-summary.json, v8 or istanbul) — returns [] without one.
 */
export class CoverageChurnCollector implements DiscoveryCollector {
  readonly name = 'coverage_churn';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const summary = await readJsonFile<CoverageSummary>(
      `${repoRoot}/coverage/coverage-summary.json`,
    );
    if (!summary) return findings;

    const churnLog = await git(repoRoot, [
      'log',
      '--since=30 days ago',
      '--numstat',
      '--format=',
      '--',
      'src',
    ]);
    const churn = parseNumstat(churnLog);
    const repoPrefix = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;

    for (const [rawFile, fileSummary] of Object.entries(summary)) {
      if (rawFile === 'total' || !fileSummary) continue;
      const file = rawFile.startsWith(repoPrefix) ? rawFile.slice(repoPrefix.length) : rawFile;
      if (!file.startsWith('src/')) continue; // core files only
      const linesPct = fileSummary.lines?.pct;
      const branchesPct = fileSummary.branches?.pct;
      if (linesPct === undefined || linesPct >= LOW_COVERAGE_PCT) continue;
      const churnLines = churn.get(file) ?? 0;
      if (churnLines < HIGH_CHURN_LINES) continue;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `uncovered-high-churn:${file}`,
          targetFiles: [file],
          severity: 0.6,
          confidence: 0.85,
          verification: 0.7,
          findingPayload: {
            kind: 'uncovered-high-churn',
            linesPct,
            branchesPct: branchesPct ?? null,
            churnLines30d: churnLines,
            note: 'Uncovered lines in a core file changed heavily in the last 30 days.',
          },
        }),
      );
    }
    return findings;
  }
}
