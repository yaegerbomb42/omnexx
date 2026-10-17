import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GateConfig } from '../config/schema.js';
import type { Baseline } from '../core/run-store.js';
import type { GateResult } from './gates.js';
import { judgeGate } from './ratchet.js';

/** More changed files than this and the related set is most of the suite anyway. */
const MAX_FILES = 40;
/** Compound commands are left alone: there's no telling which part runs the tests. */
const SHELL_OPS = /[;&|<>`$()\n]/;
const ENV = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const PY_TEST = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;

const VITEST = new RegExp(
  String.raw`^(${ENV}(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:\S*/)?vitest)(?:\s+run)?((?:\s+.*)?)$`,
);
const JEST = new RegExp(
  String.raw`^(${ENV}(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:\S*/)?jest)((?:\s+.*)?)$`,
);
const PYTEST = new RegExp(
  String.raw`^(${ENV}(?:(?:uv\s+run|poetry\s+run|pipenv\s+run)\s+)?(?:python3?\s+-m\s+)?pytest)((?:\s+.*)?)$`,
);
const GO_TEST = new RegExp(String.raw`^(${ENV}go\s+test)((?:\s+.*)?)$`);
const CARGO_TEST = new RegExp(String.raw`^(${ENV}cargo\s+test)((?:\s+.*)?)$`);
/** Options that pick packages themselves, or the whole workspace. */
const CARGO_SCOPE = /^(?:-p|--package(?:=.*)?|--workspace|--all|--manifest-path(?:=.*)?)$/;
const SCRIPT = /^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)$/;
/** How each package manager runs a binary from node_modules/.bin. */
const RUNNER_PREFIX: Record<string, string> = {
  npm: 'npx',
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  bun: 'bunx',
};

const quote = (s: string): string => (/^[\w./@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const tokens = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
/** A bare argument naming where tests live (a path, a test dir); options and their values stay. */
const isPathArg = (t: string): boolean =>
  !t.startsWith('-') && (t.includes('/') || t.endsWith('.py') || t === '.' || /^tests?$/.test(t));

/**
 * The gate's command narrowed to the tests related to `files`: `vitest related`, `jest
 * --findRelatedTests`, `pytest <changed test files>`, `go test <changed packages>`, `cargo test
 * -p <changed crates>` (workspaces only; `crates` maps each changed file to its package). Undefined
 * when the runner isn't one of these, the command is compound, or nothing narrows it.
 */
export function narrowCommand(
  command: string,
  files: readonly string[],
  crates: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  const cmd = command.trim();
  if (!files.length || files.length > MAX_FILES || SHELL_OPS.test(cmd)) return undefined;
  if (/\s--watch\b|\srelated\b|--findRelatedTests|--onlyChanged/.test(cmd)) return undefined;
  const js = files.filter((f) => JS_FILE.test(f));
  let m = VITEST.exec(cmd);
  if (m) {
    if (!js.length) return undefined;
    return `${m[1] ?? ''} related --run --passWithNoTests${m[2] ?? ''} ${js.map(quote).join(' ')}`;
  }
  m = JEST.exec(cmd);
  if (m) {
    if (!js.length) return undefined;
    return `${m[1] ?? ''}${m[2] ?? ''} --passWithNoTests --findRelatedTests ${js.map(quote).join(' ')}`;
  }
  m = PYTEST.exec(cmd);
  if (m) {
    const tests = files.filter((f) => PY_TEST.test(f));
    if (!tests.length) return undefined;
    const opts = tokens(m[2] ?? '').filter((t) => !isPathArg(t));
    return [m[1] ?? '', ...opts, ...tests.map(quote)].join(' ');
  }
  m = GO_TEST.exec(cmd);
  if (m) {
    const pkgs = [
      ...new Set(
        files
          .filter((f) => f.endsWith('.go'))
          .map((f) => (dirname(f) === '.' ? '.' : `./${dirname(f)}`)),
      ),
    ];
    if (!pkgs.length) return undefined;
    const opts = tokens(m[2] ?? '').filter((t) => !(t.startsWith('.') || t.includes('...')));
    return [m[1] ?? '', ...opts, ...pkgs.map(quote)].join(' ');
  }
  m = CARGO_TEST.exec(cmd);
  if (m) return narrowCargo(m[1] ?? '', tokens(m[2] ?? ''), files, crates);
  return undefined;
}

function narrowCargo(
  head: string,
  opts: readonly string[],
  files: readonly string[],
  crates: ReadonlyMap<string, string>,
): string | undefined {
  if (opts.some((t) => CARGO_SCOPE.test(t))) return undefined;
  const rust = files.filter((f) => f.endsWith('.rs') || /(?:^|\/)Cargo\.toml$/.test(f));
  if (!rust.length) return undefined;
  const pkgs = new Set<string>();
  for (const f of rust) {
    const pkg = crates.get(f);
    // A changed file outside every member crate (the root manifest, a shared build script)
    // can affect them all: run the whole suite.
    if (!pkg) return undefined;
    pkgs.add(pkg);
  }
  return [head, ...[...pkgs].sort((a, b) => a.localeCompare(b)).flatMap((p) => ['-p', quote(p)]), ...opts].join(' ');
}

const PACKAGE_NAME = /^\[package\][^[]*?^\s*name\s*=\s*["']([^"']+)["']/ms;

/**
 * For a Cargo workspace, the package of each changed Rust file (its nearest `Cargo.toml` with a
 * `[package]`). Empty for a single-crate repo, where `-p` would run the whole suite anyway.
 */
export async function readCrates(
  cwd: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const root = await readFile(join(cwd, 'Cargo.toml'), 'utf8').catch(() => '');
  if (!/^\s*\[workspace\]/m.test(root)) return out;
  const names = new Map<string, string | undefined>();
  const nameIn = async (dir: string): Promise<string | undefined> => {
    if (!names.has(dir)) {
      const toml = await readFile(join(cwd, dir, 'Cargo.toml'), 'utf8').catch(() => '');
      names.set(dir, PACKAGE_NAME.exec(toml)?.[1]);
    }
    return names.get(dir);
  };
  for (const f of files) {
    if (!f.endsWith('.rs') && !/(?:^|\/)Cargo\.toml$/.test(f)) continue;
    for (let dir = dirname(f); dir !== '.' && dir !== '/'; dir = dirname(dir)) {
      const pkg = await nameIn(dir);
      if (pkg) {
        out.set(f, pkg);
        break;
      }
    }
  }
  return out;
}

/** `npm test` and friends: the script they run, ready to run directly. */
export function scriptCommand(
  command: string,
  scripts: Readonly<Record<string, string>>,
): string | undefined {
  const m = SCRIPT.exec(command.trim());
  if (!m) return undefined;
  const script = scripts[m[2] ?? '']?.trim();
  if (!script) return undefined;
  // Scripts see node_modules/.bin on PATH; run directly they need the package runner.
  return /^(?:vitest|jest)\b/.test(script) ? `${RUNNER_PREFIX[m[1] ?? 'npm']} ${script}` : script;
}

/** The repo's package.json scripts; none when there is no readable one. */
export async function readScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: unknown;
    };
    if (typeof pkg.scripts !== 'object' || pkg.scripts === null) return {};
    return Object.fromEntries(
      Object.entries(pkg.scripts).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/** The gate narrowed to the tests related to `files`, or undefined to run it in full. */
export function relatedGate(
  gate: GateConfig,
  files: readonly string[],
  scripts: Readonly<Record<string, string>>,
  crates: ReadonlyMap<string, string> = new Map(),
): GateConfig | undefined {
  if (gate.kind === 'browser') return undefined;
  const direct = narrowCommand(gate.run, files, crates);
  if (direct) return { ...gate, run: direct };
  const script = scriptCommand(gate.run, scripts);
  const viaScript = script ? narrowCommand(script, files, crates) : undefined;
  return viaScript ? { ...gate, run: viaScript } : undefined;
}

/**
 * Whether a narrowed run settles the check as red: it named failures the full gate would fail
 * on too. Anything else (green, no tests found, output the parser couldn't read, a timeout)
 * says nothing about the full suite, which then runs.
 */
export function relatedRed(r: GateResult, baseline: Baseline | undefined): boolean {
  if (!r.structured || r.timedOut || r.failures.length === 0) return false;
  return !judgeGate(r, baseline).pass;
}

/** A narrowed run that passed real tests (it found some, and none failed). */
export const relatedGreen = (r: GateResult): boolean =>
  r.structured && !r.timedOut && r.exitCode === 0 && (r.tests?.total ?? 0) > 0;
