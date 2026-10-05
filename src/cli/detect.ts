import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateParser } from '../config/schema.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DetectedGate {
  name: string;
  run: string;
  level: 'must-pass' | 'ratchet';
  parser: GateParser;
  timeout: string;
}

export interface Detection {
  language: 'node' | 'python' | 'go' | 'unknown';
  packageManager: PackageManager | undefined;
  setup: string[];
  gates: DetectedGate[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

async function detectPackageManager(root: string): Promise<PackageManager> {
  for (const [file, pm] of LOCKFILES) if (await exists(join(root, file))) return pm;
  return 'npm';
}

function installCommand(pm: PackageManager, hasLock: boolean): string {
  switch (pm) {
    case 'npm':
      return hasLock ? 'npm ci' : 'npm install';
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
  }
}

const run = (pm: PackageManager, script: string): string =>
  pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
const exec = (pm: PackageManager, bin: string): string =>
  pm === 'npm' ? `npx --no-install ${bin}` : `${pm} exec ${bin}`;

async function detectNode(root: string): Promise<Detection> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson;
  const pm = await detectPackageManager(root);
  const hasLock = await Promise.all(LOCKFILES.map(([f]) => exists(join(root, f)))).then((r) =>
    r.some(Boolean),
  );
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const gates: DetectedGate[] = [];

  if (scripts.typecheck) {
    gates.push({
      name: 'typecheck',
      run: run(pm, 'typecheck'),
      level: 'ratchet',
      parser: 'tsc',
      timeout: '5m',
    });
  } else if ('typescript' in deps && (await exists(join(root, 'tsconfig.json')))) {
    gates.push({
      name: 'typecheck',
      run: `${exec(pm, 'tsc')} --noEmit`,
      level: 'ratchet',
      parser: 'tsc',
      timeout: '5m',
    });
  }
  if (scripts.lint) {
    gates.push({
      name: 'lint',
      run: run(pm, 'lint'),
      level: 'ratchet',
      parser: 'generic',
      timeout: '5m',
    });
  }
  const testScript = scripts.test;
  if ('vitest' in deps) {
    gates.push({
      name: 'test',
      run: `${exec(pm, 'vitest')} run --reporter=json --outputFile=/dev/stdout`,
      level: 'ratchet',
      parser: 'vitest',
      timeout: '20m',
    });
  } else if ('jest' in deps) {
    gates.push({
      name: 'test',
      run: `${exec(pm, 'jest')} --json`,
      level: 'ratchet',
      parser: 'jest',
      timeout: '20m',
    });
  } else if (testScript && /\bnode\s+--test\b/.test(testScript)) {
    gates.push({
      name: 'test',
      run: `${run(pm, 'test')} -- --test-reporter=tap`,
      level: 'ratchet',
      parser: 'node-test',
      timeout: '20m',
    });
  } else if (testScript && !testScript.includes('no test specified')) {
    gates.push({
      name: 'test',
      run: run(pm, 'test'),
      level: 'ratchet',
      parser: 'generic',
      timeout: '20m',
    });
  }
  return { language: 'node', packageManager: pm, setup: [installCommand(pm, hasLock)], gates };
}

export async function detectProject(root: string): Promise<Detection> {
  if (await exists(join(root, 'package.json'))) return detectNode(root);
  if (await exists(join(root, 'go.mod'))) {
    return {
      language: 'go',
      packageManager: undefined,
      setup: ['go mod download'],
      gates: [
        { name: 'vet', run: 'go vet ./...', level: 'ratchet', parser: 'generic', timeout: '5m' },
        {
          name: 'test',
          run: 'go test -json ./...',
          level: 'ratchet',
          parser: 'gotest',
          timeout: '20m',
        },
      ],
    };
  }
  const py = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'requirements.txt'];
  for (const f of py) {
    if (await exists(join(root, f))) {
      return {
        language: 'python',
        packageManager: undefined,
        setup: [],
        gates: [
          {
            name: 'test',
            run: 'python -m pytest -q -rf',
            level: 'ratchet',
            parser: 'pytest',
            timeout: '20m',
          },
        ],
      };
    }
  }
  return { language: 'unknown', packageManager: undefined, setup: [], gates: [] };
}

const q = (s: string): string => JSON.stringify(s);

/** Render omnexx.toml by hand so it carries comments; parsed back by the loader in tests. */
export function renderProjectToml(d: Detection): string {
  const lines = [
    '# omnexx.toml: project config for Omnexx. Every key and default: docs/config.md',
    '',
    `setup = [${d.setup.map(q).join(', ')}]`,
    'sandbox = "host"',
    '',
  ];
  if (d.gates.length === 0) {
    lines.push(
      '# No gates detected. Omnexx refuses multi-cycle runs without at least one gate.',
      '# [[gates]]',
      '# name = "test"',
      '# run = "make test"',
      '',
    );
  }
  for (const g of d.gates) {
    lines.push(
      '[[gates]]',
      `name = ${q(g.name)}`,
      `run = ${q(g.run)}`,
      `timeout = ${q(g.timeout)}`,
      `level = ${q(g.level)}`,
      `parser = ${q(g.parser)}`,
      '',
    );
  }
  lines.push(
    '[budget]',
    'max_usd = 50',
    'max_hours = 24',
    '',
    '[git]',
    'push = "none"',
    '',
    '# Models default to Anthropic (ANTHROPIC_API_KEY). Any OpenAI-compatible endpoint works too:',
    '# [models]',
    '# planner = "openrouter:anthropic/claude-opus-5.5"',
    '# worker  = ["openrouter:deepseek/deepseek-v4", "local:qwen3-coder"]',
    '# cheap   = "local:qwen3-coder"',
    '#',
    '# [providers.endpoints.openrouter]',
    '# base_url = "https://openrouter.ai/api/v1"',
    '# api_key_env = "OPENROUTER_API_KEY"',
    '#',
    '# [providers.endpoints.local]',
    '# base_url = "http://localhost:11434/v1"',
    '# free = true',
    '#',
    '# Paid models outside Anthropic need a [pricing.<alias>] entry: see docs/config.md.',
    '',
  );
  return lines.join('\n');
}
