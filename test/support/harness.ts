import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import type { ConfigInput, OmnexxConfig } from '../../src/config/schema.js';
import { createRun } from '../../src/core/create.js';
import { resolvePaths } from '../../src/core/paths.js';
import { applyPlanUpdate, type PlanUpdate } from '../../src/core/plan.js';
import { Run, type RunHooks } from '../../src/core/run.js';
import { git } from '../../src/git/git.js';
import type { Provider } from '../../src/providers/types.js';
import { FakeClock } from './clock.js';
import { isolatedEnv, tempRepo } from './tmp.js';

export const NODE_TEST_GATE = {
  name: 'test',
  run: 'node --test --test-reporter=tap',
  parser: 'node-test' as const,
  timeout: '2m',
};

/** A temp git repo seeded from test/fixtures/repos/<name>, with one commit. */
export async function fixtureRepo(name: string): Promise<string> {
  const repo = await tempRepo();
  const src = join('test/fixtures/repos', name);
  for (const entry of await readdir(src))
    await cp(join(src, entry), join(repo, entry), { recursive: true });
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', `fixture ${name}`]);
  return repo;
}

export interface TestRun {
  run: Run;
  repo: string;
  env: NodeJS.ProcessEnv;
  config: OmnexxConfig;
  clock: FakeClock;
}

export async function startTestRun(opts: {
  fixture?: string;
  provider: Provider;
  plan?: PlanUpdate;
  repo?: string;
  config?: ConfigInput;
  env?: NodeJS.ProcessEnv;
  hooks?: RunHooks;
  fetch?: typeof fetch;
  goal?: string;
}): Promise<TestRun> {
  const repo = opts.repo ?? (await fixtureRepo(opts.fixture ?? 'ts-failing-test'));
  const env = opts.env ?? (await isolatedEnv());
  // Beyond mode adds planner calls after the goal is met; tests opt in explicitly.
  const config = defaultConfig({
    gates: [NODE_TEST_GATE],
    beyond: { enabled: false },
    // Review and audit add model calls; tests for them opt in explicitly.
    review: { enabled: false, audit: false, strict_checks: false },
    // Tests keep the real HOME; never let the host's ~/.claude/skills into a test run's prompts.
    skills: { import_claude: false },
    ...opts.config,
  });
  const clock = new FakeClock();
  const paths = resolvePaths(env);
  const goal = opts.goal ?? 'Make the test suite pass.';
  const store = await createRun({ paths, cwd: repo, goal, now: clock.now() });
  const run = await Run.open(
    {
      config,
      paths,
      env,
      clock,
      provider: opts.provider,
      fetch: opts.fetch ?? (() => Promise.reject(new Error('network is not allowed in tests'))),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
    },
    store.runId,
  );
  if (opts.plan) {
    run.plan = applyPlanUpdate(undefined, opts.plan, goal);
    await run.savePlan();
  }
  return { run, repo, env, config, clock };
}

/** A repo with one passing node test and the given extra files, committed. */
export async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const repo = await tempRepo();
  const all = {
    'package.json': '{"type":"module"}\n',
    'test/ok.test.js': "import { test } from 'node:test';\ntest('ok', () => {});\n",
    ...files,
  };
  for (const [f, c] of Object.entries(all)) {
    await mkdir(dirname(join(repo, f)), { recursive: true });
    await writeFile(join(repo, f), c);
  }
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'seed']);
  return repo;
}
