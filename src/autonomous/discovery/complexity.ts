import { readFile } from 'node:fs/promises';
import { git, parseNumstatCommits, readJsonFile } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

interface CoverageFileSummary {
  lines?: { pct?: number };
}

type CoverageSummary = Record<string, CoverageFileSummary | undefined>;

/** Flag functions whose estimated cyclomatic complexity exceeds this. */
const COMPLEXITY_LIMIT = 20;
/** Flag files longer than this many lines. */
const FILE_LENGTH_LIMIT = 600;
/** Flag exact duplicate blocks of at least this many lines. */
const CLONE_MIN_LINES = 10;
/** Gate: only files touched in at least this many commits in the last 30 days. */
const MIN_TOUCHES_30D = 3;
/** Gate: only files with at least this line coverage (when coverage data exists). */
const MIN_COVERAGE_PCT = 80;

/**
 * Heuristic complexity scan. ts-morph is NOT a dependency of this repo, so
 * this uses a lightweight regex + brace-matching fallback (noted on every
 * finding): decision-token counting per function body, file length, and exact
 * clone-block detection over normalized lines.
 *
 * Gate: only files modified ≥3 times in the last 30 days with ≥80% coverage
 * are queued. When no coverage summary exists the coverage gate is skipped
 * and the finding says so (`coverageUnknown: true`).
 */
export class ComplexityCollector implements DiscoveryCollector {
  readonly name = 'complexity';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const touchesLog = await git(repoRoot, [
      'log',
      '--since=30 days ago',
      '--numstat',
      '--format=commit %H',
      '--',
      'src',
    ]);
    const touches = parseNumstatCommits(touchesLog);
    const gated = new Set<string>();
    for (const [file, count] of touches) {
      if (count >= MIN_TOUCHES_30D) gated.add(file);
    }
    if (gated.size === 0) return findings;

    const summary = await readJsonFile<CoverageSummary>(
      `${repoRoot}/coverage/coverage-summary.json`,
    );
    const coverageUnknown = !summary;

    for (const file of gated) {
      if (!/\.(?:ts|tsx)$/.test(file) || /test|spec/i.test(file)) continue;
      if (summary) {
        const pct = summary[file]?.lines?.pct;
        if (pct !== undefined && pct < MIN_COVERAGE_PCT) continue;
      }
      let content: string;
      try {
        content = await readFile(`${repoRoot}/${file}`, 'utf8');
      } catch {
        continue;
      }
      findings.push(...this.scanFile(file, content, coverageUnknown));
    }
    findings.push(...(await this.scanClones(repoRoot, [...gated])));
    return findings;
  }

  private scanFile(file: string, content: string, coverageUnknown: boolean): RawFinding[] {
    const findings: RawFinding[] = [];
    const lines = content.split('\n');
    if (lines.length > FILE_LENGTH_LIMIT) {
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `file-too-long:${file}`,
          targetFiles: [file],
          severity: 0.5,
          confidence: 0.9,
          verification: 0.6,
          findingPayload: {
            kind: 'file-too-long',
            lines: lines.length,
            limit: FILE_LENGTH_LIMIT,
            analysis: 'heuristic-regex-fallback',
            note: 'ts-morph is not a dependency; length measured by line count.',
            coverageUnknown,
          },
        }),
      );
    }
    for (const fn of extractFunctions(content)) {
      const complexity = 1 + countDecisionTokens(fn.body);
      if (complexity <= COMPLEXITY_LIMIT) continue;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `complex-function:${file}:${fn.name}`,
          canonicalSymbol: fn.name,
          targetFiles: [file],
          severity: 0.55,
          confidence: 0.7,
          verification: 0.5,
          findingPayload: {
            kind: 'high-complexity',
            function: fn.name,
            estimatedComplexity: complexity,
            limit: COMPLEXITY_LIMIT,
            analysis: 'heuristic-regex-fallback',
            note: 'ts-morph is not a dependency; complexity estimated by counting decision tokens (if/for/while/case/catch/&&/||/?:) in the function body.',
            coverageUnknown,
          },
        }),
      );
    }
    return findings;
  }

  /** Exact duplicate blocks (≥10 normalized lines) across gated files. */
  private async scanClones(repoRoot: string, files: string[]): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const seen = new Map<string, { file: string; start: number }>();
    for (const file of files) {
      if (!/\.(?:ts|tsx)$/.test(file)) continue;
      let content: string;
      try {
        content = await readFile(`${repoRoot}/${file}`, 'utf8');
      } catch {
        continue;
      }
      const normalized = content
        .split('\n')
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .filter((line) => line.length > 0 && !line.startsWith('//'));
      for (let i = 0; i + CLONE_MIN_LINES <= normalized.length; i++) {
        const block = normalized.slice(i, i + CLONE_MIN_LINES).join('\n');
        const first = seen.get(block);
        if (!first) {
          seen.set(block, { file, start: i + 1 });
          continue;
        }
        if (first.file === file) continue;
        findings.push(
          makeFinding({
            collector: this.name,
            ruleOrTestId: `clone-block:${first.file}:${file}`,
            targetFiles: [first.file, file],
            severity: 0.45,
            confidence: 0.85,
            verification: 0.6,
            findingPayload: {
              kind: 'clone-block',
              lines: CLONE_MIN_LINES,
              firstLocation: `${first.file}:${first.start}`,
              secondLocation: `${file}:${i + 1}`,
              analysis: 'heuristic-regex-fallback',
            },
          }),
        );
        // One clone finding per pair is enough; stop scanning this block further.
        seen.delete(block);
      }
    }
    return findings;
  }
}

interface ExtractedFunction {
  name: string;
  body: string;
}

/** Best-effort function extraction: named functions, methods, and arrow functions with bodies. */
function extractFunctions(content: string): ExtractedFunction[] {
  const out: ExtractedFunction[] = [];
  const patterns: RegExp[] = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^{]+)?=>\s*\{/g,
    /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1] as string;
      const braceIndex = content.indexOf('{', match.index);
      if (braceIndex === -1) continue;
      const body = extractBalancedBody(content, braceIndex);
      if (body !== undefined) out.push({ name, body });
    }
  }
  return out;
}

/** Return the text inside a balanced `{...}` starting at braceIndex, or undefined if unbalanced. */
function extractBalancedBody(content: string, braceIndex: number): string | undefined {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = braceIndex; i < content.length; i++) {
    const ch = content[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(braceIndex + 1, i);
    }
  }
  return undefined;
}

const DECISION_TOKEN = /\b(?:if|for|while|case|catch|switch)\b|&&|\|\||\?\.|\?\s*[^:?.]/g;

function countDecisionTokens(body: string): number {
  // Strip strings/comments so tokens inside them don't inflate the count.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  return stripped.match(DECISION_TOKEN)?.length ?? 0;
}
