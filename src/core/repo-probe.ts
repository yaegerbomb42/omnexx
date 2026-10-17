import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { FactKind } from './facts.js';

/**
 * Deterministic, local-only look at a worktree: package-manager scripts, language toolchains,
 * and monorepo markers. No network, no installs, no test runs. A fact is emitted only when the
 * files say how to run it.
 *
 * The probe hash is sha256 (16 hex chars) of the inputs that decide those facts:
 * - package.json: `packageManager`, the workspaces flag, and the bodies of scripts named
 *   test, lint, build, and typecheck
 * - pyproject.toml: whether a pytest runner is declared; Cargo.toml: `[package]` / `[workspace]`
 * - marker filenames (not their contents): lockfiles, pnpm-workspace.yaml, lerna.json, nx.json,
 *   pytest.ini, tox.ini, go.mod, go.work
 */
export interface ProbeFactDraft {
  kind: FactKind;
  statement: string;
  command?: string;
}

export interface RepoProbe {
  hash: string;
  facts: ProbeFactDraft[];
}

const SCRIPT_NAMES = ['test', 'lint', 'build', 'typecheck'] as const;
type ScriptName = (typeof SCRIPT_NAMES)[number];

const SCRIPT_LABEL: Record<ScriptName, string> = {
  test: 'Run tests',
  lint: 'Run lint',
  build: 'Run build',
  typecheck: 'Run typecheck',
};

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: readonly { name: string; pm: Pm }[] = [
  { name: 'bun.lock', pm: 'bun' },
  { name: 'bun.lockb', pm: 'bun' },
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'package-lock.json', pm: 'npm' },
  { name: 'npm-shrinkwrap.json', pm: 'npm' },
];

/** Filenames whose presence is a fact input. Contents are not hashed. */
const MARKERS = [
  ...LOCKFILES.map((l) => l.name),
  'pnpm-workspace.yaml',
  'lerna.json',
  'nx.json',
  'pytest.ini',
  'tox.ini',
  'go.mod',
  'go.work',
] as const;

interface HashPart {
  key: string;
  body: string;
}

const hashParts = (parts: readonly HashPart[]): string => {
  const text = [...parts]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => `${p.key}\0${p.body}`)
    .join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
};

async function exists(root: string, name: string): Promise<boolean> {
  try {
    await stat(join(root, name));
    return true;
  } catch {
    return false;
  }
}

async function readOptional(root: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, name), 'utf8');
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function depName(spec: string): string {
  const bare = spec.trim().split(/[<>=![\s;@]/, 1)[0] ?? '';
  return bare.toLowerCase();
}

function depNames(value: unknown): string[] {
  if (typeof value === 'string') return [depName(value)];
  if (Array.isArray(value)) return value.flatMap((item) => depNames(item));
  const rec = asRecord(value);
  return rec ? Object.keys(rec).map((key) => depName(key)) : [];
}

function hasPytest(doc: Record<string, unknown>): boolean {
  const tool = asRecord(doc.tool);
  if (tool && 'pytest' in tool) return true;
  const project = asRecord(doc.project);
  if (depNames(project?.dependencies).includes('pytest')) return true;
  const optional = asRecord(project?.['optional-dependencies']);
  if (optional && Object.values(optional).some((group) => depNames(group).includes('pytest')))
    return true;
  const groups = asRecord(doc['dependency-groups']);
  if (groups && Object.values(groups).some((group) => depNames(group).includes('pytest')))
    return true;
  const poetry = asRecord(tool?.poetry);
  if (!poetry) return false;
  if (depNames(poetry.dependencies).includes('pytest')) return true;
  if (depNames(poetry['dev-dependencies']).includes('pytest')) return true;
  const group = asRecord(poetry.group);
  return (
    group !== undefined &&
    Object.values(group).some((g) => depNames(asRecord(g)?.dependencies).includes('pytest'))
  );
}

function hasWorkspaces(pkg: Record<string, unknown>): boolean {
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) return workspaces.length > 0;
  const rec = asRecord(workspaces);
  return Array.isArray(rec?.packages) && rec.packages.length > 0;
}

function packageManagerOf(field: string, present: ReadonlySet<string>): Pm | undefined {
  const named = /^(npm|pnpm|yarn|bun)@/.exec(field)?.[1];
  if (named === 'npm' || named === 'pnpm' || named === 'yarn' || named === 'bun') return named;
  const families = [...new Set(LOCKFILES.filter((l) => present.has(l.name)).map((l) => l.pm))];
  return families.length === 1 ? families[0] : undefined;
}

function scriptCommand(pm: Pm, script: ScriptName): string {
  if (pm === 'bun') return `bun run ${script}`;
  if (script === 'test') return `${pm} test`;
  return `${pm} run ${script}`;
}

function nodeFacts(
  pkgText: string | undefined,
  present: ReadonlySet<string>,
  parts: HashPart[],
  facts: ProbeFactDraft[],
): void {
  if (pkgText === undefined) return;
  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = asRecord(JSON.parse(pkgText) as unknown);
  } catch {
    parts.push({ key: 'package.json', body: 'invalid' });
    return;
  }
  if (!pkg) {
    parts.push({ key: 'package.json', body: 'invalid' });
    return;
  }
  const scripts = asRecord(pkg.scripts);
  const picked: Partial<Record<ScriptName, string>> = {};
  for (const name of SCRIPT_NAMES) {
    const body = scripts?.[name];
    if (typeof body === 'string' && body.trim()) picked[name] = body;
  }
  const packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const workspaces = hasWorkspaces(pkg);
  parts.push({
    key: 'package.json',
    body: JSON.stringify({ packageManager, workspaces, scripts: picked }),
  });
  const pm = packageManagerOf(packageManager, present);
  if (pm) {
    for (const name of SCRIPT_NAMES) {
      if (!picked[name]) continue;
      const command = scriptCommand(pm, name);
      facts.push({
        kind: name,
        command,
        statement: `${SCRIPT_LABEL[name]}: \`${command}\``,
      });
    }
  }
  if (workspaces) {
    facts.push({ kind: 'convention', statement: 'Monorepo: package.json workspaces' });
  }
}

function pyprojectFacts(
  text: string | undefined,
  parts: HashPart[],
  facts: ProbeFactDraft[],
): void {
  if (text === undefined) return;
  let pytest: boolean;
  try {
    const doc = asRecord(parseToml(text));
    pytest = doc !== undefined && hasPytest(doc);
    parts.push({ key: 'pyproject.toml#pytest', body: pytest ? '1' : '0' });
  } catch {
    parts.push({ key: 'pyproject.toml#pytest', body: 'invalid' });
    return;
  }
  if (pytest) facts.push({ kind: 'test', command: 'pytest', statement: 'Run tests: `pytest`' });
}

function cargoFacts(text: string | undefined, parts: HashPart[], facts: ProbeFactDraft[]): void {
  if (text === undefined) return;
  let pkg: boolean;
  let workspace: boolean;
  try {
    const doc = asRecord(parseToml(text));
    pkg = asRecord(doc?.package) !== undefined;
    workspace = asRecord(doc?.workspace) !== undefined;
  } catch {
    parts.push({ key: 'Cargo.toml', body: 'invalid' });
    return;
  }
  parts.push({ key: 'Cargo.toml', body: `package=${pkg ? 1 : 0},workspace=${workspace ? 1 : 0}` });
  if (!pkg && !workspace) return;
  const suffix = workspace ? ' --workspace' : '';
  facts.push({
    kind: 'test',
    command: `cargo test${suffix}`,
    statement: `Run tests: \`cargo test${suffix}\``,
  });
  facts.push({
    kind: 'build',
    command: `cargo build${suffix}`,
    statement: `Run build: \`cargo build${suffix}\``,
  });
  if (workspace) facts.push({ kind: 'convention', statement: 'Monorepo: Cargo workspace' });
}

const MARKER_FACTS: readonly { name: string; fact: ProbeFactDraft }[] = [
  {
    name: 'pnpm-workspace.yaml',
    fact: { kind: 'convention', statement: 'Monorepo: pnpm workspaces' },
  },
  { name: 'lerna.json', fact: { kind: 'convention', statement: 'Monorepo: lerna' } },
  { name: 'nx.json', fact: { kind: 'convention', statement: 'Monorepo: nx' } },
  {
    name: 'pytest.ini',
    fact: { kind: 'test', command: 'pytest', statement: 'Run tests: `pytest`' },
  },
  { name: 'tox.ini', fact: { kind: 'test', command: 'tox', statement: 'Run tests: `tox`' } },
  {
    name: 'go.mod',
    fact: { kind: 'test', command: 'go test ./...', statement: 'Run tests: `go test ./...`' },
  },
  { name: 'go.work', fact: { kind: 'convention', statement: 'Monorepo: Go workspace (go.work)' } },
];

/** Probe `root` from files on disk. Missing or unreadable inputs produce no fact for that item. */
export async function probeRepo(root: string): Promise<RepoProbe> {
  const [presentList, packageJson, pyproject, cargo] = await Promise.all([
    Promise.all(MARKERS.map(async (name) => ((await exists(root, name)) ? name : undefined))),
    readOptional(root, 'package.json'),
    readOptional(root, 'pyproject.toml'),
    readOptional(root, 'Cargo.toml'),
  ]);
  const present = new Set(presentList.filter((name): name is (typeof MARKERS)[number] => !!name));
  const parts: HashPart[] = [...present].map((name) => ({ key: `marker:${name}`, body: '' }));
  const facts: ProbeFactDraft[] = [];
  nodeFacts(packageJson, present, parts, facts);
  pyprojectFacts(pyproject, parts, facts);
  cargoFacts(cargo, parts, facts);
  for (const { name, fact } of MARKER_FACTS) {
    if (present.has(name)) facts.push(fact);
  }
  const seen = new Set<string>();
  const unique = facts.filter((fact) => {
    const key = fact.command ?? fact.statement;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { hash: hashParts(parts), facts: unique };
}
