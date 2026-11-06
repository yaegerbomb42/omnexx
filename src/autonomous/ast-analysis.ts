import { execa } from 'execa';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Shared low-level plumbing for the autonomous daemon's verification modules:
 * TypeScript AST analysis (assertion counting, skip/only detection, cyclomatic
 * complexity, import collection) and a small injectable command runner so the
 * pipeline, ratchet and flake detector can all be unit-tested with stubbed
 * commands instead of spawning real tsc / vitest runs.
 */

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCommandResult>;

/** Default runner: execa, never throws on non-zero exit, never hangs forever. */
export const defaultRunCommand: RunCommand = async (command, args, opts) => {
  const started = Date.now();
  const result = await execa(command, [...args], {
    cwd: opts.cwd,
    reject: false,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stripFinalNewline: true,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
  };
};

// ---------------------------------------------------------------------------
// AST analysis (TypeScript compiler API — no ts-morph dependency in this repo)
// ---------------------------------------------------------------------------

export interface SourceAnalysis {
  /** Calls to expect(...) / assert(...) (including expect(x).toBe, assert.ok, …). */
  assertionCount: number;
  /** Any `.skip` / `.only` / xdescribe / xit / fit marker. */
  hasSkipOrOnly: boolean;
  /** Highest per-function cyclomatic complexity (1 + decision points). */
  maxCyclomaticComplexity: number;
  /** Raw relative import specifiers (`./…` / `../…`). */
  relativeImports: string[];
}

const TEST_FNS = new Set([
  'describe',
  'it',
  'test',
  'xit',
  'xdescribe',
  'xtest',
  'fit',
  'fdescribe',
]);
const SKIP_ONLY = new Set(['skip', 'only']);

function isDecision(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    return (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    );
  }
  return false;
}

/** Analyse one source text. Pure — no filesystem access. */
export function analyzeSourceText(sourceText: string, fileName = 'file.ts'): SourceAnalysis {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  let assertionCount = 0;
  let hasSkipOrOnly = false;
  let maxComplexity = 0;
  const relativeImports: string[] = [];

  const isTestCall = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'expect' || callee.text === 'assert';
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      return callee.expression.text === 'expect' || callee.expression.text === 'assert';
    }
    return false;
  };

  const isFunctionLike = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node);

  // Cyclomatic complexity, scored per function (nested functions get their own
  // budget) plus one unit for top-level code.
  const scoreFunction = (fn: ts.Node): void => {
    let decisions = 0;
    const walk = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        scoreFunction(node);
        return;
      }
      if (isDecision(node)) decisions++;
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(fn, walk);
    maxComplexity = Math.max(maxComplexity, 1 + decisions);
  };
  let topLevelDecisions = 0;
  const walkTopLevel = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      scoreFunction(node);
      return;
    }
    if (isDecision(node)) topLevelDecisions++;
    ts.forEachChild(node, walkTopLevel);
  };
  ts.forEachChild(sf, walkTopLevel);
  maxComplexity = Math.max(maxComplexity, 1 + topLevelDecisions);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith('.')) relativeImports.push(spec);
    }
    if (ts.isCallExpression(node)) {
      if (isTestCall(node)) assertionCount++;
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && SKIP_ONLY.has(callee.name.text)) {
        const obj = callee.expression;
        if (ts.isIdentifier(obj) && TEST_FNS.has(obj.text)) hasSkipOrOnly = true;
      }
      if (
        ts.isIdentifier(callee) &&
        (callee.text === 'xit' ||
          callee.text === 'xdescribe' ||
          callee.text === 'xtest' ||
          callee.text === 'fit' ||
          callee.text === 'fdescribe')
      ) {
        hasSkipOrOnly = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { assertionCount, hasSkipOrOnly, maxCyclomaticComplexity: maxComplexity, relativeImports };
}

/** Analyse one file from disk. Returns zeros when the file cannot be read. */
export function analyzeFile(filePath: string): SourceAnalysis {
  try {
    return analyzeSourceText(readFileSync(filePath, 'utf8'), filePath);
  } catch {
    return {
      assertionCount: 0,
      hasSkipOrOnly: false,
      maxCyclomaticComplexity: 0,
      relativeImports: [],
    };
  }
}

/** Total expect/assert calls across the given files. */
export function countAssertionsInFiles(filePaths: readonly string[]): number {
  return filePaths.reduce((sum, p) => sum + analyzeFile(p).assertionCount, 0);
}

/** Highest per-function cyclomatic complexity across the given files. */
export function maxComplexityInFiles(filePaths: readonly string[]): number {
  return filePaths.reduce((max, p) => Math.max(max, analyzeFile(p).maxCyclomaticComplexity), 0);
}

/** Relative import specifiers of one file (for the flake detector's import graph). */
export function collectRelativeImports(filePath: string): string[] {
  return analyzeFile(filePath).relativeImports;
}
