import type { Baseline } from '../core/run-store.js';
import type { FileChange } from '../git/repo.js';
import { matchesAny } from '../security/glob.js';
import type { GateResult } from './gates.js';

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
  [/@ts-(ignore|nocheck|expect-error)\b/, '@ts-ignore'],
  [/eslint-disable/, 'eslint-disable'],
  [/#\s*type:\s*ignore/, 'type: ignore'],
  [/#\s*noqa\b/, 'noqa'],
  [/\bt\.Skip(Now|f)?\s*\(/, 'go t.Skip'],
];

export interface AntiCheatInput {
  changes: readonly FileChange[];
  patch: string;
  protectedPatterns: readonly string[];
  /** From the task's `allow` list: delete-tests, skip, snapshots, protected. */
  allow: readonly string[];
  baseline: Baseline | undefined;
  results: readonly GateResult[];
}

export function antiCheat(input: AntiCheatInput): Violation[] {
  const allow = new Set(input.allow);
  const out: Violation[] = [];
  const isTest = (p: string): boolean => matchesAny(p, TEST_FILE_PATTERNS) !== undefined;

  if (!allow.has('delete-tests')) {
    for (const c of input.changes) {
      if (c.status === 'D' && isTest(c.path)) out.push({ rule: 'deleted-test', detail: c.path });
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

  if (!allow.has('skip')) {
    let file = '';
    for (const line of input.patch.split('\n')) {
      if (line.startsWith('+++ ')) {
        file = line.replace(/^\+\+\+ (b\/)?/, '');
        continue;
      }
      if (!line.startsWith('+')) continue;
      for (const [re, label] of MARKERS) {
        if (re.test(line)) {
          out.push({
            rule: 'skip-marker',
            detail: `${label} added in ${file}: ${line.slice(1).trim().slice(0, 120)}`,
          });
          break;
        }
      }
    }
  }

  if (!allow.has('snapshots')) {
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
