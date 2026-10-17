import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readTextOr, writeJsonAtomic } from './atomic.js';
import type { OmnexxPaths } from './paths.js';
import { probeRepo, type RepoProbe } from './repo-probe.js';
import { repoMemoryFile } from './repo-memory.js';
import { estimateTokens } from './tokens.js';

/**
 * Verified repo facts: how to build, test, lint and run this repo. A run that exited 0 records
 * one bound to the files that decide it (package.json, lockfiles, ...). When a bound file
 * changes, that fact is shown as unverified until the command passes again. A session start also
 * records probe facts (`source: "probe"`) from the worktree files, keyed by a hash of those
 * inputs. Stored next to the repo's lessons, outside the repo (never committed).
 */
export const FACT_KINDS = [
  'build',
  'test',
  'lint',
  'typecheck',
  'run',
  'env',
  'path',
  'convention',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** Files whose content decides how a repo builds and tests; a fact binds to those present. */
export const BINDING_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'tox.ini',
  'Makefile',
  'justfile',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
] as const;

const factSchema = z.object({
  id: z.string().regex(/^F\d+$/),
  kind: z.enum(FACT_KINDS),
  statement: z.string().min(1).max(400),
  command: z.string().max(400).optional(),
  source: z.enum(['gate', 'command', 'remember', 'probe']),
  /** Hash of the probe inputs. Set only on `source: "probe"` facts. */
  probeHash: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  verified: z.object({ exitCode: z.number(), at: z.string(), durationMs: z.number() }),
  boundTo: z.array(z.object({ path: z.string(), hash: z.string() })),
  stale: z.boolean().optional(),
});
export type Fact = z.infer<typeof factSchema>;
const factsSchema = z.array(factSchema);

/** Most facts kept per repo; the oldest go first. */
export const MAX_FACTS = 40;
/** Rough token cap on the injected block. */
export const FACTS_BLOCK_MAX_TOKENS = 300;
/** Longer commands are one-offs, not facts worth keeping. */
const MAX_COMMAND_CHARS = 200;

const KIND_RULES: readonly [FactKind, RegExp][] = [
  ['typecheck', /\b(typecheck|type-check|tsc\b[^|;&]*--noEmit|mypy|pyright|cargo check)\b/i],
  [
    'lint',
    /\b(lint|eslint|ruff|flake8|pylint|clippy|golangci|format:check|prettier\s+--check|biome)\b/i,
  ],
  ['test', /\b(test|tests|vitest|jest|pytest|mocha|rspec|phpunit|ctest)\b/i],
  [
    'env',
    /\b(npm ci|npm install|pnpm install|yarn install|pip install|uv sync|poetry install|bundle install)\b/i,
  ],
  ['build', /\b(build|tsc|make|cargo build|go build|webpack|rollup|esbuild|gradle|mvn)\b/i],
];

/** Programs that build, test, lint or install; a commit message that says "tests" is not a test run. */
const RUNNERS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'node',
  'make',
  'just',
  'cargo',
  'go',
  'python',
  'python3',
  'pytest',
  'uv',
  'poetry',
  'pip',
  'tox',
  'nox',
  'tsc',
  'eslint',
  'prettier',
  'ruff',
  'mypy',
  'pyright',
  'vitest',
  'jest',
  'mvn',
  'gradle',
  './gradlew',
  'bundle',
  'rake',
  'rspec',
  'dotnet',
  'ctest',
  'cmake',
]);

/** The program a command runs, past a leading `cd dir &&` and `VAR=value` assignments. */
function programOf(command: string): string {
  const rest = command.replace(/^\s*cd\s+\S+\s*&&\s*/, '');
  return (
    rest
      .trim()
      .split(/\s+/)
      .find((w) => !/^[A-Za-z_]\w*=/.test(w)) ?? ''
  );
}

/** What kind of fact a command establishes, or undefined when it isn't a build/test/lint-ish one. */
export function classifyCommand(command: string): FactKind | undefined {
  const c = command.trim();
  if (!c || c.length > MAX_COMMAND_CHARS || !RUNNERS.has(programOf(c))) return undefined;
  return KIND_RULES.find(([, re]) => re.test(c))?.[0];
}

const hashText = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Content hashes of the binding files present at `root`. */
export async function bindingHashes(
  root: string,
  files: readonly string[] = BINDING_FILES,
): Promise<Fact['boundTo']> {
  const out = await Promise.all(
    files.map(async (path) => {
      const text = await readFile(join(root, path)).catch(() => undefined);
      return text === undefined ? undefined : { path, hash: hashText(text.toString('utf8')) };
    }),
  );
  return out.filter((b): b is Fact['boundTo'][number] => b !== undefined);
}

/** Facts with `stale` set when any bound file changed or vanished since it was verified. */
export async function withStaleness(facts: readonly Fact[], root: string): Promise<Fact[]> {
  const paths = [...new Set(facts.flatMap((f) => f.boundTo.map((b) => b.path)))];
  const now = new Map((await bindingHashes(root, paths)).map((b) => [b.path, b.hash]));
  return facts.map((f) => ({
    ...f,
    stale: f.stale === true || f.boundTo.some((b) => now.get(b.path) !== b.hash),
  }));
}

export interface Verification {
  kind: FactKind;
  statement: string;
  command?: string;
  source: Fact['source'];
  exitCode: number;
  durationMs: number;
  at: string;
}

const sameFact = (a: Fact, v: Verification): boolean =>
  v.command !== undefined ? a.command === v.command : a.statement === v.statement;

const nextId = (facts: readonly Fact[]): string =>
  `F${facts.reduce((m, f) => Math.max(m, Number(f.id.slice(1))), 0) + 1}`;

/**
 * Fold a run into the facts: a pass verifies (or re-verifies) its fact and rebinds it to the
 * current file hashes; a failure of a known command marks that fact stale.
 */
export function applyVerification(
  facts: readonly Fact[],
  v: Verification,
  boundTo: Fact['boundTo'],
): Fact[] {
  const existing = facts.find((f) => sameFact(f, v));
  if (v.exitCode !== 0) {
    return existing ? facts.map((f) => (f === existing ? { ...f, stale: true } : f)) : [...facts];
  }
  const fact: Fact = {
    id: existing?.id ?? nextId(facts),
    kind: v.kind,
    // A remembered statement says more than the generated one; keep it.
    statement:
      existing?.source === 'remember' && v.source !== 'remember' ? existing.statement : v.statement,
    ...(v.command !== undefined ? { command: v.command } : {}),
    source: existing?.source === 'remember' ? 'remember' : v.source,
    verified: { exitCode: 0, at: v.at, durationMs: Math.round(v.durationMs) },
    boundTo,
  };
  const rest = facts.filter((f) => f !== existing);
  return [...rest, fact].slice(-MAX_FACTS);
}

export async function factsFile(
  paths: Pick<OmnexxPaths, 'home'>,
  repoRoot: string,
): Promise<string> {
  return join(dirname(await repoMemoryFile(paths, repoRoot)), 'facts.json');
}

export async function readFacts(
  paths: Pick<OmnexxPaths, 'home'>,
  repoRoot: string,
): Promise<Fact[]> {
  const raw = await readTextOr(await factsFile(paths, repoRoot), '[]');
  try {
    const parsed = factsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function writeFacts(
  paths: Pick<OmnexxPaths, 'home'>,
  repoRoot: string,
  facts: readonly Fact[],
): Promise<void> {
  await writeJsonAtomic(await factsFile(paths, repoRoot), facts);
}

const KIND_ORDER: readonly FactKind[] = [
  'test',
  'build',
  'typecheck',
  'lint',
  'env',
  'run',
  'path',
  'convention',
];
const SOURCE_ORDER: readonly Fact['source'][] = ['gate', 'remember', 'probe', 'command'];

/** Most useful first: verified before stale, gates before ad-hoc commands, then kind, newest. */
export function rankFacts(facts: readonly Fact[]): Fact[] {
  return [...facts].sort(
    (a, b) =>
      Number(a.stale === true) - Number(b.stale === true) ||
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      b.verified.at.localeCompare(a.verified.at),
  );
}

export function renderFact(f: Fact): string {
  const cmd = f.command && !f.statement.includes(f.command) ? ` \`${f.command}\`` : '';
  const status = f.stale
    ? 'unverified: inputs changed since'
    : `verified ${f.verified.at.slice(0, 10)}, ${Math.round(f.verified.durationMs / 1000)}s`;
  return `- [${f.id}] ${f.kind}: ${f.statement}${cmd} (${status})`;
}

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The "Verified facts" block for the agent's context, capped at `maxTokens`. Facts whose
 * statement is already a lesson are left out (the lessons block says it).
 */
export function renderFactsBlock(
  facts: readonly Fact[],
  lessons: readonly string[] = [],
  maxTokens = FACTS_BLOCK_MAX_TOKENS,
): string {
  const known = new Set(lessons.map(norm));
  const head = '# Verified facts about this repo (ran and passed; unverified ones need a rerun)';
  const lines: string[] = [];
  for (const f of rankFacts(facts).filter((x) => !known.has(norm(x.statement)))) {
    const line = renderFact(f);
    if (estimateTokens([head, ...lines, line].join('\n')) > maxTokens) break;
    lines.push(line);
  }
  return lines.length ? [head, ...lines].join('\n') : '';
}

/**
 * Fold a repo probe into stored facts. The same probe hash keeps probe facts byte-for-byte; a new
 * hash replaces them. Facts from `remember`, gates, and passed commands are left in place, so a
 * hand-written command is never dropped because the probe disagrees.
 */
export function applyProbe(facts: readonly Fact[], probe: RepoProbe, at: string): Fact[] {
  const probed = facts.filter((f) => f.source === 'probe');
  if (probed.length > 0 && probed.every((f) => f.probeHash === probe.hash)) return [...facts];
  const kept = facts.filter((f) => f.source !== 'probe');
  const commands = new Set(kept.flatMap((f) => (f.command ? [f.command] : [])));
  const statements = new Set(kept.map((f) => f.statement));
  let acc = [...kept];
  for (const draft of probe.facts) {
    if ((draft.command && commands.has(draft.command)) || statements.has(draft.statement)) continue;
    const fact: Fact = {
      id: nextId(acc),
      kind: draft.kind,
      statement: draft.statement,
      ...(draft.command !== undefined ? { command: draft.command } : {}),
      source: 'probe',
      probeHash: probe.hash,
      verified: { exitCode: 0, at, durationMs: 0 },
      boundTo: [],
    };
    acc = [...acc, fact];
    if (draft.command) commands.add(draft.command);
    statements.add(draft.statement);
  }
  return capFacts(acc);
}

/** Remembered and gate facts stay when a probe would otherwise push the list past the cap. */
function capFacts(facts: readonly Fact[]): Fact[] {
  if (facts.length <= MAX_FACTS) return [...facts];
  const pinned = facts.filter((f) => f.source === 'remember' || f.source === 'gate');
  const rest = facts.filter((f) => f.source !== 'remember' && f.source !== 'gate');
  const keptPinned = pinned.slice(-MAX_FACTS);
  const room = MAX_FACTS - keptPinned.length;
  return [...keptPinned, ...rest.slice(-Math.max(0, room))];
}

/** The facts block for `repoRoot`, staleness checked against `workdir` (a run's worktree). */
export async function factsBlockFor(
  paths: Pick<OmnexxPaths, 'home'>,
  repoRoot: string,
  workdir: string,
  lessons: readonly string[] = [],
): Promise<string> {
  try {
    const existing = await readFacts(paths, repoRoot);
    let facts = existing;
    try {
      const next = applyProbe(existing, await probeRepo(workdir), new Date().toISOString());
      if (JSON.stringify(next) !== JSON.stringify(existing))
        await writeFacts(paths, repoRoot, next);
      facts = next;
    } catch {
      // Probe or write failed: still show facts already recorded for this repo.
    }
    return renderFactsBlock(await withStaleness(facts, workdir), lessons);
  } catch {
    return '';
  }
}
