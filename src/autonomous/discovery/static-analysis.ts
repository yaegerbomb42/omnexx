import { changedFiles, fileExists, runCommand, safeJsonParse } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
}

interface EslintFileResult {
  filePath?: string;
  messages?: EslintMessage[];
}

interface KnipIssue {
  file?: string;
  name?: string;
}

interface KnipReport {
  files?: string[];
  exports?: Record<string, Record<string, KnipIssue>>;
  types?: Record<string, Record<string, KnipIssue>>;
}

/**
 * Type errors, lint errors on changed files, and unused exports.
 * Deterministic: no LLM calls. Each tool is optional — a missing binary or a
 * tool failure degrades to [] for that source instead of failing the collector.
 */
export class StaticAnalysisCollector implements DiscoveryCollector {
  readonly name = 'static_analysis';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    findings.push(...(await this.collectTypeErrors(repoRoot)));
    findings.push(...(await this.collectLintErrors(repoRoot)));
    findings.push(...(await this.collectUnusedExports(repoRoot)));
    return findings;
  }

  /** `tsc --noEmit`: every error line becomes a finding (severity 0.9). */
  private async collectTypeErrors(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const result = await runCommand(
      'npx',
      ['tsc', '--noEmit', '--pretty', 'false'],
      repoRoot,
      180_000,
    );
    if (result.timedOut) return findings;
    const output = `${result.stdout}\n${result.stderr}`;
    for (const line of output.split('\n')) {
      // src/foo.ts(12,3): error TS2304: Cannot find name 'x'.
      const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line);
      if (!match) continue;
      const [, file, lineNo, colNo, code, message] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: code,
          targetFiles: [file],
          severity: 0.9,
          confidence: 1.0,
          verification: 0.9,
          findingPayload: {
            kind: 'type-error',
            line: Number(lineNo),
            column: Number(colNo),
            message: message.trim().slice(0, 300),
          },
        }),
      );
    }
    return findings;
  }

  /** ESLint (JSON) over files changed vs HEAD; errors only, warnings are noise here. */
  private async collectLintErrors(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const files = (await changedFiles(repoRoot, 50)).filter((f) =>
      /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(f),
    );
    if (files.length === 0) return findings;
    const result = await runCommand(
      'npx',
      ['eslint', '--format', 'json', ...files],
      repoRoot,
      120_000,
    );
    if (result.timedOut) return findings;
    const report = safeJsonParse(result.stdout.trim()) as EslintFileResult[] | undefined;
    if (!report) return findings;
    for (const fileResult of report) {
      const relPath = relativeTo(repoRoot, fileResult.filePath ?? '');
      for (const msg of fileResult.messages ?? []) {
        if (msg.severity !== 2) continue; // errors only
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: msg.ruleId ?? 'eslint-error',
            targetFiles: relPath ? [relPath] : [],
            severity: 0.75,
            confidence: 0.95,
            verification: 0.8,
            findingPayload: {
              kind: 'lint-error',
              line: msg.line,
              column: msg.column,
              message: (msg.message ?? '').slice(0, 300),
            },
          }),
        );
      }
    }
    return findings;
  }

  /**
   * Unused exports via knip (preferred) or ts-prune, when installed.
   * Neither is a dependency of this repo, so both are skipped gracefully.
   */
  private async collectUnusedExports(repoRoot: string): Promise<RawFinding[]> {
    if (fileExists(`${repoRoot}/node_modules/.bin/knip`)) {
      return this.collectKnip(repoRoot);
    }
    if (fileExists(`${repoRoot}/node_modules/.bin/ts-prune`)) {
      return this.collectTsPrune(repoRoot);
    }
    return [];
  }

  private async collectKnip(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const result = await runCommand(
      'npx',
      ['knip', '--no-progress', '--reporter', 'json'],
      repoRoot,
      120_000,
    );
    if (result.timedOut) return findings;
    const report = safeJsonParse(result.stdout.trim()) as KnipReport | undefined;
    if (!report) return findings;
    for (const file of report.files ?? []) {
      findings.push(unusedFinding(this.name, file, 'unused-file', 'Unused file reported by knip.'));
    }
    for (const [file, byName] of Object.entries(report.exports ?? {})) {
      for (const name of Object.keys(byName)) {
        findings.push(
          unusedFinding(this.name, file, `unused-export:${name}`, `Unused export '${name}'.`),
        );
      }
    }
    for (const [file, byName] of Object.entries(report.types ?? {})) {
      for (const name of Object.keys(byName)) {
        findings.push(
          unusedFinding(this.name, file, `unused-type:${name}`, `Unused type '${name}'.`),
        );
      }
    }
    return findings;
  }

  private async collectTsPrune(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const result = await runCommand('npx', ['ts-prune'], repoRoot, 120_000);
    if (result.timedOut) return findings;
    for (const line of result.stdout.split('\n')) {
      // src/foo.ts:12 - bar (used in module)
      const match = /^(.+?):(\d+) - (\S+)/.exec(line);
      if (!match) continue;
      const [, file, lineNo, name] = match as unknown as [string, string, string, string];
      findings.push(
        unusedFinding(
          this.name,
          file,
          `unused-export:${name}`,
          `Unused export '${name}' (ts-prune, line ${lineNo}).`,
        ),
      );
    }
    return findings;
  }
}

function unusedFinding(
  collector: string,
  file: string,
  ruleOrTestId: string,
  message: string,
): RawFinding {
  return makeFinding({
    collector,
    ruleOrTestId,
    targetFiles: [file],
    severity: 0.4,
    confidence: 0.8,
    verification: 0.6,
    findingPayload: { kind: 'unused-export', message },
  });
}

function relativeTo(repoRoot: string, absolutePath: string): string {
  if (!absolutePath) return '';
  const prefix = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}
