import { readFile } from 'node:fs/promises';
import { fileExists, git, joinRoot } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

/**
 * FeatureOpportunityCollector — mines high-leverage opportunities for novel features,
 * UI/UX polish, architectural modernization, and positive entropic capabilities.
 *
 * Scans:
 * 1. ROADMAP.md / ARCHITECTURE.md for actionable feature milestones.
 * 2. Uncovered UI components in vscode/src/webview or cli commands lacking test/feature depth.
 * 3. High-impact core subsystems that have no companion integration or property tests.
 */
export class FeatureOpportunityCollector implements DiscoveryCollector {
  readonly name = 'feature_opportunity';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    findings.push(...(await this.collectRoadmapMilestones(repoRoot)));
    findings.push(...(await this.collectUiOpportunities(repoRoot)));
    findings.push(...(await this.collectUntestedSubsystems(repoRoot)));
    return findings;
  }

  /** Actionable uncompleted feature items in ROADMAP.md or ARCHITECTURE.md */
  private async collectRoadmapMilestones(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const candidates = ['ROADMAP.md', 'ARCHITECTURE.md', 'docs/ROADMAP.md'];

    for (const rel of candidates) {
      const full = joinRoot(repoRoot, rel);
      if (!fileExists(full)) continue;
      let text = '';
      try {
        text = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() ?? '';
        // Unchecked markdown task item: - [ ] Add feature XYZ
        if (/^-\s*\[\s*\]\s+(.+)$/i.test(line)) {
          const match = /^-\s*\[\s*\]\s+(.+)$/i.exec(line);
          const title = match?.[1]?.trim() ?? '';
          if (title.length < 5) continue;

          findings.push(
            makeFinding({
              collector: this.name,
              ruleOrTestId: `roadmap:${rel}:${String(i + 1)}`,
              canonicalSymbol: title.slice(0, 40),
              targetFiles: [rel],
              severity: 0.75,
              confidence: 0.85,
              verification: 0.8,
              findingPayload: {
                kind: 'roadmap-milestone',
                doc: rel,
                line: i + 1,
                title,
                description: `Implement roadmap feature milestone: "${title}"`,
              },
            }),
          );
        }
      }
    }
    return findings;
  }

  /** UI and webview enhancement opportunities */
  private async collectUiOpportunities(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const filesOutput = await git(repoRoot, ['ls-files', 'vscode/src/webview']);
    const uiFiles = filesOutput.split('\n').filter(Boolean);

    for (const file of uiFiles) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.css')) continue;
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;

      const full = joinRoot(repoRoot, file);
      let content = '';
      try {
        content = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const symbol = file.split('/').pop()?.replace(/\.[^.]+$/, '');
      if (content.includes('TODO') || content.includes('empty state') || content.includes('ErrorBoundary')) {
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: `ui-polish:${file}`,
            ...(symbol ? { canonicalSymbol: symbol } : {}),
            targetFiles: [file],
            severity: 0.65,
            confidence: 0.8,
            verification: 0.7,
            findingPayload: {
              kind: 'ui-enhancement',
              file,
              summary: `Refactor and polish UI/webview component for enhanced user experience: ${file}`,
            },
          }),
        );
      }
    }
    return findings;
  }

  /** Subsystems with core business logic that lack focused tests */
  private async collectUntestedSubsystems(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const filesOutput = await git(repoRoot, ['ls-files', 'src/core']);
    const coreFiles = filesOutput.split('\n').filter(Boolean);

    for (const file of coreFiles) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;
      const testPath = file.replace(/^src\//, 'test/unit/').replace(/\.ts$/, '.test.ts');
      const symbol = file.split('/').pop()?.replace(/\.ts$/, '');
      if (!fileExists(joinRoot(repoRoot, testPath))) {
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: `untested-subsystem:${file}`,
            ...(symbol ? { canonicalSymbol: symbol } : {}),
            targetFiles: [file],
            severity: 0.7,
            confidence: 0.9,
            verification: 0.85,
            findingPayload: {
              kind: 'untested-core-subsystem',
              sourceFile: file,
              suggestedTestFile: testPath,
              summary: `Architect comprehensive test harness and interface verification for core module: ${file}`,
            },
          }),
        );
      }
    }
    return findings.slice(0, 10);
  }
}
