import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { git } from '../git/git.js';

/**
 * Where an improvement round should look, read from the repo rather than imagined: files that
 * change often and are big (hotspots), source files no test names, and TODO/FIXME clusters.
 * Deterministic and model-free, so a day-long run gets fresh targets every round for free.
 */
export type FindingKind = 'hotspot' | 'untested' | 'todo';

export interface Finding {
  kind: FindingKind;
  path: string;
  detail: string;
  score: number;
}

export interface RepoSignals {
  /** Source files (tests excluded) with their line counts. */
  files: readonly { path: string; lines: number }[];
  /** Commits touching each path in the churn window. */
  churn: ReadonlyMap<string, number>;
  /** TODO/FIXME/HACK/XXX markers per path. */
  todos: ReadonlyMap<string, number>;
  /** Paths of test files. */
  tests: readonly string[];
}

const SOURCE = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.scala',
]);
const SKIP_DIR =
  /(^|\/)(node_modules|dist|build|out|vendor|target|coverage|\.next|__generated__|generated)\//;
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/;
const CHURN_DAYS = 180;
const PER_KIND = 4;
const MIN_HOTSPOT_LINES = 150;
const MIN_UNTESTED_LINES = 40;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

export function isSourcePath(path: string): boolean {
  return SOURCE.has(extname(path)) && !SKIP_DIR.test(path) && !path.endsWith('.d.ts');
}

/** The name a test would use for a module: `src/core/plan.ts` and `test_plan.py` are both "plan". */
function stem(path: string): string {
  return basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](test|spec)$/, '')
    .replace(/^test_/, '')
    .replace(/_test$/, '')
    .toLowerCase();
}

/**
 * The top findings of each kind, best first and interleaved so no kind crowds out the others.
 * `exclude` holds paths earlier rounds were already shown.
 */
export function rankEvidence(
  s: RepoSignals,
  exclude: ReadonlySet<string> = new Set(),
  limit = 8,
): Finding[] {
  const fresh = s.files.filter((f) => !exclude.has(f.path));
  const hotspots = fresh
    .filter((f) => f.lines >= MIN_HOTSPOT_LINES && (s.churn.get(f.path) ?? 0) >= 3)
    .map((f) => {
      const n = s.churn.get(f.path) ?? 0;
      return {
        kind: 'hotspot' as const,
        path: f.path,
        detail: `changed in ${String(n)} commits over ${String(CHURN_DAYS)} days, ${String(f.lines)} lines`,
        score: n * Math.log2(f.lines),
      };
    });
  const tested = new Set(s.tests.map(stem));
  const untested = fresh
    .filter((f) => f.lines >= MIN_UNTESTED_LINES && !tested.has(stem(f.path)))
    .map((f) => ({
      kind: 'untested' as const,
      path: f.path,
      detail: `${String(f.lines)} lines and no test file named after it`,
      score: f.lines * (1 + (s.churn.get(f.path) ?? 0)),
    }));
  const todos = [...s.todos]
    .filter(([path, n]) => n >= 2 && !exclude.has(path))
    .map(([path, n]) => ({
      kind: 'todo' as const,
      path,
      detail: `${String(n)} TODO/FIXME markers`,
      score: n,
    }));
  const lists = [hotspots, untested, todos].map((l) =>
    l.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)),
  );
  const next = lists.map(() => 0);
  const taken = lists.map(() => 0);
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (let progressed = true; progressed && out.length < limit;) {
    progressed = false;
    lists.forEach((l, k) => {
      if (out.length >= limit || (taken[k] ?? 0) >= PER_KIND) return;
      let i = next[k] ?? 0;
      while (i < l.length && seen.has(l[i]?.path ?? '')) i++;
      const f = l[i];
      next[k] = i + 1;
      if (!f) return;
      seen.add(f.path);
      out.push(f);
      taken[k] = (taken[k] ?? 0) + 1;
      progressed = true;
    });
  }
  return out;
}

export function evidenceText(findings: readonly Finding[]): string {
  return findings.map((f) => `- ${f.kind} \`${f.path}\`: ${f.detail}`).join('\n');
}

/** Line counts are read for at most this many files; past it the repo is sampled by churn. */
const MAX_FILES = 3000;

/** Read the signals from a git checkout. Any git failure yields no signals, not an error. */
export async function readSignals(cwd: string): Promise<RepoSignals> {
  const listed = await git(cwd, ['ls-files', '-z'], { allowFailure: true });
  if (listed.exitCode !== 0) return { files: [], churn: new Map(), todos: new Map(), tests: [] };
  const all = listed.stdout.split('\0').filter(Boolean);
  const tests = all.filter(isTestPath);
  const sources = all.filter((p) => isSourcePath(p) && !isTestPath(p));
  const churn = new Map<string, number>();
  const log = await git(
    cwd,
    ['log', `--since=${String(CHURN_DAYS)}.days`, '--no-merges', '--name-only', '--format='],
    { allowFailure: true },
  );
  for (const p of log.stdout.split('\n')) if (p) churn.set(p, (churn.get(p) ?? 0) + 1);
  const picked = [...sources]
    .sort((a, b) => (churn.get(b) ?? 0) - (churn.get(a) ?? 0))
    .slice(0, MAX_FILES);
  const files = await Promise.all(
    picked.map(async (path) => {
      const text = await readFile(join(cwd, path), 'utf8').catch(() => '');
      return { path, lines: text ? text.split('\n').length : 0 };
    }),
  );
  const todos = new Map<string, number>();
  const grep = await git(cwd, ['grep', '-I', '-c', '-w', '-E', 'TODO|FIXME|HACK|XXX'], {
    allowFailure: true,
  });
  for (const line of grep.stdout.split('\n')) {
    const at = line.lastIndexOf(':');
    const path = line.slice(0, at);
    if (at > 0 && isSourcePath(path) && !isTestPath(path))
      todos.set(path, Number(line.slice(at + 1)));
  }
  return { files, churn, todos, tests };
}

export async function mineEvidence(
  cwd: string,
  exclude: ReadonlySet<string> = new Set(),
  limit = 8,
): Promise<Finding[]> {
  return rankEvidence(await readSignals(cwd), exclude, limit);
}
