import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { PROJECT_CONFIG } from '../config/load.js';
import { git } from '../git/git.js';
import { detectBrowserBackend } from '../tools/extra/browser/detector.js';
import { renderProjectToml, type DetectedGate, type Detection } from './detect.js';

/** Files an empty folder may already hold without counting as a project. */
const IGNORABLE = new Set(['.git', '.DS_Store', 'Thumbs.db', '.gitignore']);

/**
 * True when `dir` has no project files yet and no commits: a folder made for a new idea.
 * Anything else (a real repo, a home directory) is never touched.
 */
export async function isEmptyProject(dir: string): Promise<boolean> {
  const entries = await readdir(dir);
  if (entries.some((e) => !IGNORABLE.has(e))) return false;
  if (!entries.includes('.git')) return true;
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
  return head.exitCode !== 0;
}

/**
 * Starter gates call npm scripts with --if-present, so the agent picks the stack and wires up
 * build, lint and typecheck by adding scripts; the gates in omnexx.toml (protected) never change.
 */
export const STARTER_DETECTION: Detection = {
  language: 'node',
  packageManager: 'npm',
  setup: ['npm install'],
  gates: [
    {
      name: 'build',
      run: 'npm run build --if-present',
      level: 'must-pass',
      parser: 'generic',
      timeout: '10m',
    },
    {
      name: 'lint',
      run: 'npm run lint --if-present',
      level: 'ratchet',
      parser: 'generic',
      timeout: '5m',
    },
    {
      name: 'typecheck',
      run: 'npm run typecheck --if-present',
      level: 'ratchet',
      parser: 'generic',
      timeout: '5m',
    },
    {
      name: 'test',
      run: 'npm test -- --test-reporter=tap',
      level: 'ratchet',
      parser: 'node-test',
      timeout: '20m',
    },
  ],
};

/**
 * Opens the app in a real browser once it has a `start` script: it must load, render
 * something and log no console errors. Skipped until then, so non-web projects never pay.
 */
export const PAGE_GATE: DetectedGate = {
  name: 'page',
  run: 'npm start',
  level: 'must-pass',
  parser: 'generic',
  timeout: '3m',
  kind: 'browser',
  requires_script: 'start',
};

const AGENTS_MD = `# Agent notes

This project was started from an empty folder by omnexx. The checks that decide whether work is
accepted are fixed in omnexx.toml and call these npm scripts:

- \`build\`, \`lint\`, \`typecheck\`: run only if present. Add them as soon as the stack has them.
- \`test\`: \`node --test\`. Add tests under \`test/\` as you build; the test count may only grow.

- \`start\` (web projects only): serve the app on the port in \`$PORT\`. When it exists, every
  change is opened in a real browser and rejected if the page is blank or logs console errors.

Pick whatever stack fits the goal, but keep these scripts working and \`npm install\` clean.
`;

function packageJson(name: string): string {
  const pkg = {
    name:
      name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'app',
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Turn an empty folder into a repo omnexx can run on: git init, a starter package.json,
 * omnexx.toml with starter gates, AGENTS.md, and one commit. Returns the files written.
 */
const WRITING_TOML = `# omnexx project config. Every key: docs/config.md in the omnexx repo.
# A writing project: no tests; each piece is checked by its plan's checks and a reviewer.
[plan]
kind = "writing"
`;

const WRITING_AGENTS_MD = `# Writing project

Prose lives in Markdown files. Keep the outline and the bible (names, facts, style rules)
current; every chapter follows them.
`;

export async function bootstrapEmptyProject(
  dir: string,
  opts: { browser?: boolean; writing?: boolean } = {},
): Promise<string[]> {
  if (opts.writing) return bootstrapWritingProject(dir);
  if (!(await isEmptyProject(dir)))
    throw new Error('Refusing to bootstrap a folder that already has files');
  const browser = opts.browser ?? (await detectBrowserBackend()).backend !== null;
  const detection = browser
    ? { ...STARTER_DETECTION, gates: [...STARTER_DETECTION.gates, PAGE_GATE] }
    : STARTER_DETECTION;
  const head = await git(dir, ['rev-parse', '--git-dir'], { allowFailure: true });
  if (head.exitCode !== 0) await git(dir, ['init', '-q']);
  const files: Record<string, string> = {
    'package.json': packageJson(basename(dir)),
    [PROJECT_CONFIG]: renderProjectToml(detection),
    'AGENTS.md': AGENTS_MD,
  };
  const existing = await readdir(dir);
  if (!existing.includes('.gitignore')) files['.gitignore'] = 'node_modules/\ndist/\n.DS_Store\n';
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
  await git(dir, ['add', '-A']);
  const email = await git(dir, ['config', 'user.email'], { allowFailure: true });
  const who = email.stdout.trim()
    ? []
    : ['-c', 'user.name=omnexx', '-c', 'user.email=omnexx@users.noreply.invalid'];
  await git(dir, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...who,
    'commit',
    '--no-verify',
    '-q',
    '-m',
    'chore: start project with omnexx',
  ]);
  return Object.keys(files);
}

/** A folder for prose: config and notes only, no package.json and no test gates. */
async function bootstrapWritingProject(dir: string): Promise<string[]> {
  if (!(await isEmptyProject(dir)))
    throw new Error('Refusing to bootstrap a folder that already has files');
  const head = await git(dir, ['rev-parse', '--git-dir'], { allowFailure: true });
  if (head.exitCode !== 0) await git(dir, ['init', '-q']);
  const files: Record<string, string> = {
    [PROJECT_CONFIG]: WRITING_TOML,
    'AGENTS.md': WRITING_AGENTS_MD,
  };
  if (!(await readdir(dir)).includes('.gitignore')) files['.gitignore'] = '.DS_Store\n';
  for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
  await git(dir, ['add', '-A']);
  const email = await git(dir, ['config', 'user.email'], { allowFailure: true });
  const who = email.stdout.trim()
    ? []
    : ['-c', 'user.name=omnexx', '-c', 'user.email=omnexx@users.noreply.invalid'];
  await git(dir, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...who,
    'commit',
    '--no-verify',
    '-q',
    '-m',
    'chore: start writing project with omnexx',
  ]);
  return Object.keys(files);
}

const TRACK_GITIGNORE = `node_modules/
dist/
build/
.venv/
venv/
__pycache__/
.DS_Store
*.log
.env
.env.*
`;

/**
 * A folder with files but no git: start tracking it so every change the agent makes can be undone.
 * Adds a .gitignore for dependencies, builds and secrets when there is none, then commits what's
 * there. Returns false when the folder already is a repository with a commit.
 */
export async function startTracking(dir: string): Promise<boolean> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
  if (top.exitCode === 0 && head.exitCode === 0) return false;
  if (top.exitCode !== 0) await git(dir, ['init', '-q']);
  if (!(await readdir(dir)).includes('.gitignore'))
    await writeFile(join(dir, '.gitignore'), TRACK_GITIGNORE);
  await git(dir, ['add', '-A']);
  const email = await git(dir, ['config', 'user.email'], { allowFailure: true });
  const who = email.stdout.trim()
    ? []
    : ['-c', 'user.name=omnexx', '-c', 'user.email=omnexx@users.noreply.invalid'];
  await git(dir, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...who,
    'commit',
    '--no-verify',
    '--allow-empty',
    '-q',
    '-m',
    'chore: start tracking with omnexx',
  ]);
  return true;
}

/** Where new projects go when omnexx is started somewhere too broad to work in. */
const PROJECTS_FOLDER = 'omnexx-projects';
const MAX_SLUG_LENGTH = 40;

function goalSlug(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/**
 * The folder a run should work in. The home folder and `/` are too broad (VS Code with no
 * folder open starts omnexx in `/`), so a goal started there gets its own new folder under
 * ~/omnexx-projects, named after the goal; an existing non-empty one gets a -2, -3... suffix.
 */
export async function projectFolderFor(
  cwd: string,
  goal: string,
  home: string = homedir(),
): Promise<{ dir: string; created: boolean }> {
  const tooBroad = new Set([resolve(home), resolve('/')]);
  if (!tooBroad.has(resolve(cwd))) return { dir: cwd, created: false };
  const base = join(home, PROJECTS_FOLDER, goalSlug(goal));
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    await mkdir(dir, { recursive: true });
    if (await isEmptyProject(dir)) return { dir, created: true };
  }
}
