import type { Baseline } from '../core/run-store.js';
import type { WorkMode } from '../config/work-mode.js';
import type { FileChange } from '../git/repo.js';
import { matchesAny } from '../security/glob.js';
import type { GateResult } from './gates.js';

function stripStringContent(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

export interface Violation {
  rule: 'deleted-test' | 'test-count-drop' | 'skip-marker' | 'snapshot-rewrite' | 'protected-path';
  detail: string;
}

export const TEST_FILE_PATTERNS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.go',
  '**/test_*.py',
  '**/*_test.py',
  'test/**',
  'tests/**',
  '**/__tests__/**',
];

/** Markers that disable or narrow tests or checks. Matched only on added lines. */
const MARKERS: readonly [RegExp, string][] = [
  [/\b(it|test|describe|suite|context)\.(skip|only|todo)\b/, '.skip/.only'],
  [/\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/, 'x/f-prefixed test'],
  [/\{\s*skip\s*:\s*(true|['"])/, 'node:test skip option'],
  [/\bt\.skip\s*\(/, 't.skip()'],
  [/@pytest\.mark\.(skip|xfail)/, '@pytest.mark.skip'],
  [/\bpytest\.skip\s*\(/, 'pytest.skip()'],
  [/\bunittest\.skip/, 'unittest.skip'],
  // Directives only count inside a comment, not as text in a string (a test listing banned markers).
  [/(\/\/|\/\*)\s*@ts-(ignore|nocheck|expect-error)\b/, '@ts-ignore'],
  [/(\/\/|\/\*)\s*eslint-disable/, 'eslint-disable'],
  [/#\s*type:\s*ignore/, 'type: ignore'],
  [/#\s*noqa\b/, 'noqa'],
  [/\bt\.Skip(Now|f)?\s*\(/, 'go t.Skip'],
];

/**
 * Tool-generated output (coverage reports ship `/* eslint-disable *\/` banners). A test run
 * writes it, not the agent, so markers there say nothing about cheating.
 */
const GENERATED_OUTPUT = ['coverage/**', '**/coverage/**', '.nyc_output/**', '**/.nyc_output/**'];

export interface AntiCheatInput {
  changes: readonly FileChange[];
  patch: string;
  protectedPatterns: readonly string[];
  /** From the task's `allow` list: delete-tests, skip, snapshots, protected. */
  allow: readonly string[];
  baseline: Baseline | undefined;
  results: readonly GateResult[];
  /**
   * The run's work domain. The test-weakening rules (deleted tests, skip markers,
   * snapshot rewrites) police a test suite; in the "general" domain there is none to
   * weaken — an artifact may legitimately quote a marker — so only the protected-path
   * rule applies there.
   */
  domain?: WorkMode;
}

/** A path without its last extension: `test/a.test.js` → `test/a.test`. */
const stem = (p: string): string => p.replace(/\.[^./]+$/, '');

/**
 * Deleted tests with an added test at the same path in another language (`a.test.js` →
 * `a.test.ts`). A port rewrites most lines, so git reports a delete plus an add, not a rename.
 */
function portedTests(changes: readonly FileChange[], isTest: (p: string) => boolean): Set<string> {
  const added = new Set(
    changes.filter((c) => c.status === 'A' && isTest(c.path)).map((c) => stem(c.path)),
  );
  return new Set(
    changes.filter((c) => c.status === 'D' && added.has(stem(c.path))).map((c) => c.path),
  );
}

export function antiCheat(input: AntiCheatInput): Violation[] {
  const allow = new Set(input.allow);
  const out: Violation[] = [];
  const isTest = (p: string): boolean => matchesAny(p, TEST_FILE_PATTERNS) !== undefined;
  // In the general domain only the protected-path rule (below) applies.
  const swe = input.domain !== 'general';

  if (swe && !allow.has('delete-tests')) {
    const ported = portedTests(input.changes, isTest);
    for (const c of input.changes) {
      if (c.status === 'D' && isTest(c.path) && !ported.has(c.path))
        out.push({ rule: 'deleted-test', detail: c.path });
      if (c.status === 'R' && c.oldPath && isTest(c.oldPath) && !isTest(c.path)) {
        out.push({ rule: 'deleted-test', detail: `${c.oldPath} renamed to non-test ${c.path}` });
      }
    }
    for (const r of input.results) {
      const before = input.baseline?.[r.name]?.tests?.total;
      const now = r.tests?.total;
      if (before !== undefined && now !== undefined && now < before) {
        out.push({ rule: 'test-count-drop', detail: `${r.name}: ${before} → ${now} tests` });
      }
    }
  }

  if (swe && !allow.has('skip')) {
    let file = '';
    for (const line of input.patch.split('\n')) {
      if (line.startsWith('+++ ')) {
        file = line.replace(/^\+\+\+ (b\/)?/, '');
        continue;
      }
      if (!line.startsWith('+') || matchesAny(file, GENERATED_OUTPUT) !== undefined) continue;
      const lineWithoutStrings = stripStringContent(line);
      for (const [re, label] of MARKERS) {
        if (re.test(lineWithoutStrings)) {
          out.push({
            rule: 'skip-marker',
            detail: `${label} added in ${file}: ${line.slice(1).trim().slice(0, 120)}`,
          });
          break;
        }
      }
    }
  }

  if (swe && !allow.has('snapshots')) {
    for (const c of input.changes) {
      if (c.status !== 'A' && (c.path.endsWith('.snap') || c.path.includes('__snapshots__/'))) {
        out.push({ rule: 'snapshot-rewrite', detail: c.path });
      }
    }
  }

  if (!allow.has('protected')) {
    for (const c of input.changes) {
      for (const p of [c.path, c.oldPath].filter((x): x is string => x !== undefined)) {
        const hit = matchesAny(p, input.protectedPatterns);
        if (hit) out.push({ rule: 'protected-path', detail: `${p} (matches "${hit}")` });
      }
    }
  }
  return out;
}
