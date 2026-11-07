import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists, readJsonFile, runCommand } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface VitestAssertion {
  title?: string;
  fullName?: string;
  status?: string;
  failureMessages?: string[];
}

interface VitestFileResult {
  name?: string;
  assertionResults?: VitestAssertion[];
}

interface VitestJsonReport {
  numFailedTests?: number;
  testResults?: VitestFileResult[];
}

/**
 * Vitest reports absolute file paths; findings must carry repo-relative
 * targets or the planner's `normalizeRepoPath` drops them (absolute paths
 * normalize to null), which makes every test_runner plan fail validation
 * with "plan touches no known target file". Same helper as static-analysis.
 */
function relativeTo(repoRoot: string, absolutePath: string): string {
  if (!absolutePath) return '';
  const prefix = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

interface TestHistoryRun {
  at: string;
  failed: string[];
}

const HISTORY_PATH = ['.omnexx', 'discovery', 'test-history.json'];
const MAX_HISTORY_RUNS = 10;
/** A test that flips between pass and fail across runs is flaky, not just broken. */
const FLAKY_SEVERITY = 0.6;

export interface TestRunnerOptions {
  timeoutMs?: number;
  /**
   * Extra args appended to `vitest run --reporter=json` (e.g. a test-file
   * filter for a scoped run). Defaults to the full suite.
   */
  vitestArgs?: string[];
}

/**
 * Runs the test suite and turns each failing test into a finding.
 * Deterministic: no LLM calls. Degrades to [] when vitest is missing, times out,
 * or its output cannot be parsed. Also mines recent CI failure logs when present
 * and flags tests that flip between pass and fail across runs as flaky.
 */
export class TestRunnerCollector implements DiscoveryCollector {
  readonly name = 'test_runner';
  private readonly timeoutMs: number;
  private readonly vitestArgs: string[];

  constructor(options: TestRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.vitestArgs = options.vitestArgs ?? [];
  }

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const failedIds = new Set<string>();

    const startedAt = Date.now();
    const result = await runCommand(
      'npx',
      ['vitest', 'run', '--reporter=json', ...this.vitestArgs],
      repoRoot,
      this.timeoutMs,
    );
    if (result.timedOut) return findings;

    const report = extractJsonReport(result.stdout) ?? (await readReportFile(repoRoot, startedAt));
    if (report) {
      for (const file of report.testResults ?? []) {
        for (const assertion of file.assertionResults ?? []) {
          if (assertion.status !== 'failed') continue;
          const testId = assertion.fullName ?? assertion.title ?? file.name ?? 'unknown test';
          failedIds.add(testId);
          findings.push(
            makeFinding({
              collector: this.name,
              ruleOrTestId: testId,
              targetFiles: file.name ? [relativeTo(repoRoot, file.name)] : [],
              severity: 1.0,
              confidence: 1.0,
              verification: 1.0,
              findingPayload: {
                kind: 'failing-test',
                failureMessages: (assertion.failureMessages ?? []).slice(0, 3),
              },
            }),
          );
        }
      }
    }

    // Recent CI failure logs, if any were captured locally.
    findings.push(...(await this.collectFromCiLogs(repoRoot, failedIds)));

    // Flaky detection against the recorded run history.
    findings.push(...(await this.detectFlaky(repoRoot, failedIds)));

    return findings;
  }

  private async collectFromCiLogs(
    repoRoot: string,
    knownFailed: Set<string>,
  ): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const logDir = join(repoRoot, '.omnexx', 'logs');
    if (!fileExists(logDir)) return findings;
    const entries = await readdir(logDir).catch(() => null);
    if (!entries) return findings;
    for (const entry of entries) {
      if (!/^(ci|test)[-_.].*\.log$/i.test(entry) && !entry.endsWith('.log')) continue;
      let content: string;
      try {
        content = await readFile(join(logDir, entry), 'utf8');
      } catch {
        continue;
      }
      // Keep only the tail: CI logs can be huge and only recent failures matter.
      const lines = content.split('\n').slice(-2000);
      for (const line of lines) {
        const match = /FAIL\s+(\S+\.(?:test|spec)\.[jt]sx?)\b/.exec(line);
        if (!match) continue;
        const file = match[1] as string;
        const testId = `ci-failure:${file}`;
        if (knownFailed.has(testId)) continue;
        knownFailed.add(testId);
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: testId,
            targetFiles: [file],
            severity: 0.9,
            confidence: 0.7,
            verification: 0.5,
            findingPayload: {
              kind: 'ci-log-failure',
              logFile: entry,
              line: line.trim().slice(0, 300),
            },
          }),
        );
      }
    }
    return findings;
  }

  private async detectFlaky(repoRoot: string, failedIds: Set<string>): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const historyPath = join(repoRoot, ...HISTORY_PATH);
    const history = (await readJsonFile<TestHistoryRun[]>(historyPath)) ?? [];
    const previousRuns = history.slice(-MAX_HISTORY_RUNS);

    const previouslyFailed = new Set<string>();
    for (const run of previousRuns) {
      for (const id of run.failed) previouslyFailed.add(id);
    }
    const lastRunFailed = new Set(previousRuns.at(-1)?.failed ?? []);

    // Failing now, passed in the last run, but failed in an earlier run: flaky.
    for (const id of failedIds) {
      if (!lastRunFailed.has(id) && previouslyFailed.has(id)) {
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: id,
            targetFiles: [],
            severity: FLAKY_SEVERITY,
            confidence: 0.8,
            verification: 0.6,
            findingPayload: {
              kind: 'flaky-test',
              note: 'Failed in this run and in an earlier recorded run, but passed in the most recent prior run.',
            },
          }),
        );
      }
    }
    // Failed in the last recorded run but passes now: also flaky (intermittent).
    for (const id of lastRunFailed) {
      if (!failedIds.has(id) && previousRuns.length > 1 && previouslyFailed.has(id)) {
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: id,
            targetFiles: [],
            severity: FLAKY_SEVERITY,
            confidence: 0.7,
            verification: 0.6,
            findingPayload: {
              kind: 'flaky-test',
              note: 'Failed in the most recent recorded run but passes now; intermittent failure.',
            },
          }),
        );
      }
    }

    // Record this run (best effort; a missing/unwritable .omnexx dir must not fail collection).
    const nextHistory = [
      ...previousRuns,
      { at: new Date().toISOString(), failed: [...failedIds] },
    ].slice(-MAX_HISTORY_RUNS);
    try {
      await mkdir(join(repoRoot, '.omnexx', 'discovery'), { recursive: true });
      await writeFile(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8');
    } catch {
      // History is advisory only.
    }
    return findings;
  }
}

/**
 * Vitest prints the JSON report to stdout, but may prefix it with other output
 * (e.g. warnings). Take the largest JSON-looking substring and parse that.
 */
function extractJsonReport(stdout: string): VitestJsonReport | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const direct = safeParse(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return safeParse(trimmed.slice(start, end + 1));
}

function safeParse(text: string): VitestJsonReport | undefined {
  try {
    const parsed = JSON.parse(text) as VitestJsonReport;
    if (Array.isArray(parsed.testResults)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Vitest's json reporter writes the report to `.vitest/json/output.json`
 * instead of stdout in this repo's setup. Read it when stdout has no JSON,
 * but only when the file was written by this run (mtime >= run start) so a
 * stale report from an earlier run can't masquerade as current results.
 */
async function readReportFile(
  repoRoot: string,
  startedAt: number,
): Promise<VitestJsonReport | undefined> {
  const path = join(repoRoot, '.vitest', 'json', 'output.json');
  try {
    const info = await stat(path);
    if (info.mtimeMs < startedAt - 1000) return undefined;
    return safeParse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
