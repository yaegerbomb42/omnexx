import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  run: 'node --test --test-reporter=tap test/',
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
  fixture: string;
  provider: Provider;
  plan: PlanUpdate;
  config?: ConfigInput;
  env?: NodeJS.ProcessEnv;
  hooks?: RunHooks;
  fetch?: typeof fetch;
  goal?: string;
}): Promise<TestRun> {
  const repo = await fixtureRepo(opts.fixture);
  const env = opts.env ?? (await isolatedEnv());
  const config = defaultConfig({ gates: [NODE_TEST_GATE], ...opts.config });
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
  run.plan = applyPlanUpdate(undefined, opts.plan, goal);
  await run.savePlan();
  return { run, repo, env, config, clock };
}
