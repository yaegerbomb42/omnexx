/**
 * End-to-end daemon test: the full working loop with REAL collaborators.
 *
 * A seeded failing-test task goes discover → plan → implement → verify →
 * ship → learn against the real `LlmArchitectPlanner`, `AgentTaskExecutor`,
 * `VerificationPipeline`, `ShippingController` and `WorktreeManager`. Only
 * the model is scripted: `ScriptedProvider` answers the planner with a JSON
 * plan and the executor with tool calls, in order.
 *
 * The scripted fix is deliberately wrong on round 1 (`a * b`), so the first
 * verification FAILs and the daemon must drive the REPAIR loop: back to
 * IMPLEMENT with the verification diagnostics as a nudge, a correct fix on
 * round 2, then PASS and a Tier 1 ship (push to a local bare `origin`).
 *
 * The scratch repo is a minimal TS + vitest project whose `node_modules` is
 * a symlink to this repo's `node_modules`, so `npx tsc` / `npx vitest` /
 * `npx eslint` resolve offline in the task worktree (npx walks up from the
 * worktree to the repo root).
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutonomousDaemon } from '../../src/autonomous/daemon.js';
import { resolveAutonomousPaths } from '../../src/autonomous/state.js';
import { AutonomousStateStore } from '../../src/autonomous/state-store.js';
import { buildDaemonCollaborators } from '../../src/cli/commands/daemon.js';
import { defaultConfig } from '../../src/config/load.js';
import { JsonFileBudgetLedger } from '../../src/core/budgetGovernor.js';
import { git } from '../../src/git/git.js';
import {
  type CompletionRequest,
  type CompletionResponse,
  type Provider,
} from '../../src/providers/types.js';

/** A Provider that answers from a queue, in call order. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  readonly requests: CompletionRequest[] = [];
  private readonly replies: (CompletionResponse | Error)[];

  constructor(replies: (CompletionResponse | Error)[]) {
    this.replies = [...replies];
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const next = this.replies.shift();
    if (next === undefined) return Promise.reject(new Error('scripted provider: out of replies'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

const textReply = (text: string): CompletionResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  // Non-zero usage so the budget-ledger assertions below can see the spend:
  // 1500 tokens per call × 5 calls = 7500 tokens recorded.
  usage: { uncached: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 },
  model: 'scripted',
});

const toolReply = (calls: { id: string; name: string; input: unknown }[]): CompletionResponse => ({
  content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
  stopReason: 'tool_use',
  usage: { uncached: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 },
  model: 'scripted',
});

const ADDER_BEFORE = [
  'export function add(a: number, b: number): number {',
  '  return a - b;',
  '}',
  '',
].join('\n');

const TEST_BEFORE = [
  "import { expect, test } from 'vitest';",
  "import { add } from '../src/adder.js';",
  '',
  "test('adds two numbers', () => {",
  '  expect(add(2, 3)).toBe(5);',
  '  expect(add(0, 0)).toBe(0);',
  '});',
  '',
].join('\n');

const PLAN_JSON = [
  '```json',
  JSON.stringify(
    {
      filesToTouch: ['src/adder.ts', 'test/adder.test.ts'],
      verificationCommand: 'npx vitest run test/adder.test.ts',
      subSteps: ['Fix add() to add its arguments', 'Strengthen the test with a negative case'],
      summary: 'Fix the add() implementation and cover a negative case',
    },
    null,
    2,
  ),
  '```',
].join('\n');

describe('daemon end-to-end (real collaborators, scripted model)', () => {
  let repo: string;
  let bare: string;
  let omnexxHome: string;
  let prevOmnexxHome: string | undefined;
  let store: AutonomousStateStore;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'omnexx-e2e-'));
    bare = await mkdtemp(join(tmpdir(), 'omnexx-e2e-bare-'));
    omnexxHome = await mkdtemp(join(tmpdir(), 'omnexx-home-'));
    prevOmnexxHome = process.env.OMNEXX_HOME;
    process.env.OMNEXX_HOME = omnexxHome;
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    execFileSync('git', ['init', '--bare', '-q', bare]);
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'test'), { recursive: true });
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'e2e-repo', private: true, type: 'module' }, null, 2),
      'utf8',
    );
    await writeFile(
      join(repo, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
          },
          include: ['src', 'test'],
        },
        null,
        2,
      ),
      'utf8',
    );
    // Flat config with no rules: the lint gate passes, exercising the real
    // eslint path without depending on a rule set.
    await writeFile(join(repo, 'eslint.config.mjs'), 'export default [];\n', 'utf8');
    await writeFile(join(repo, 'src/adder.ts'), ADDER_BEFORE, 'utf8');
    await writeFile(join(repo, 'test/adder.test.ts'), TEST_BEFORE, 'utf8');
    // Offline tooling: the worktree resolves npx binaries by walking up to
    // this symlink (vitest, tsc, eslint all live in this repo's node_modules).
    const rootNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
    await symlink(rootNodeModules, join(repo, 'node_modules'), 'dir');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
    execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
  });

  afterEach(async () => {
    if (prevOmnexxHome === undefined) delete process.env.OMNEXX_HOME;
    else process.env.OMNEXX_HOME = prevOmnexxHome;
    await rm(repo, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
    await rm(omnexxHome, { recursive: true, force: true });
  });

  it(
    'runs a seeded failing-test task through plan → implement → verify (REPAIR) → ship → learn',
    { timeout: 180_000 },
    async () => {
      const config = defaultConfig({ autonomous: { enabled: true } });
      const paths = resolveAutonomousPaths(repo, config.autonomous);
      store = new AutonomousStateStore({ repoRoot: repo, dbPath: paths.dbPath });
      await store.open();

      const task = store.enqueueTask({
        fingerprint: 'e2e-adder-fix',
        sourceCollector: 'test_runner',
        priorityScore: 0.9,
        targetFiles: ['src/adder.ts', 'test/adder.test.ts'],
        // Same shape as a real triaged finding: the daemon reads
        // findingPayload.kind to pick the verification kind (Stage 3 runs
        // for test_runner). A plain string would default to kind 'other'
        // and skip the revert-test proof.
        findingPayload: {
          kind: 'failing-test',
          detail: 'add() subtracts instead of adding; test/adder.test.ts fails',
        },
      });

      // 1: planner JSON. 2–3: round 1 (wrong fix, then done). 4–5: round 2
      // (correct fix + stronger test, then done).
      const provider = new ScriptedProvider([
        textReply(PLAN_JSON),
        toolReply([
          {
            id: 'c1',
            name: 'str_replace',
            input: { path: 'src/adder.ts', old_str: 'a - b', new_str: 'a * b' },
          },
        ]),
        textReply('First fix applied; the tests should pass now.'),
        toolReply([
          {
            id: 'c2',
            name: 'str_replace',
            input: { path: 'src/adder.ts', old_str: 'a * b', new_str: 'a + b' },
          },
          {
            id: 'c3',
            name: 'str_replace',
            input: {
              path: 'test/adder.test.ts',
              old_str: '  expect(add(0, 0)).toBe(0);',
              new_str: '  expect(add(0, 0)).toBe(0);\n  expect(add(-1, 1)).toBe(0);',
            },
          },
        ]),
        textReply('Fixed add() properly and added a negative-case assertion.'),
      ]);

      const collaborators = await buildDaemonCollaborators({
        repoRoot: repo,
        config,
        paths,
        store,
        provider,
      });
      const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
      const daemon = new AutonomousDaemon({
        repoRoot: repo,
        store,
        logger: silent,
        ...collaborators,
        maxTurnsPerTask: 25,
        idleSleepBaseMs: 1,
        idleSleepMaxMs: 1,
        headPollMs: 1,
      });
      await daemon.start({ maxCycles: 1 });
      // start() shuts the daemon down and closes its store; re-open it for
      // the post-run assertions.
      await store.open();

      // Exactly the 5 scripted calls: planner once, two turns per round.
      expect(provider.requests).toHaveLength(5);

      // The task shipped and was marked done — no tombstone, no retry.
      const done = store.getDoneEntry('e2e-adder-fix');
      expect(done).not.toBeNull();
      expect(done?.deliveryMode).toBe('auto');
      expect(store.getTombstone('e2e-adder-fix')).toBeNull();

      // The step journal shows the full loop, with verify running twice
      // (round 0 REPAIR, round 1 PASS).
      const phases = store.getSteps(task.taskId).map((s) => s.phase);
      for (const phase of ['plan', 'implement', 'verify', 'ship', 'learn']) {
        expect(phases).toContain(phase);
      }
      expect(phases.filter((p) => p === 'verify').length).toBeGreaterThanOrEqual(2);

      // Tier 1: the fix commit was pushed to origin's omnexx/auto-main.
      const shipped = await git(bare, ['rev-parse', 'omnexx/auto-main'], { allowFailure: true });
      expect(shipped.exitCode).toBe(0);
      const subject = await git(bare, ['log', '-1', '--format=%s', 'omnexx/auto-main']);
      expect(subject.stdout.trim()).toMatch(/^daemon: test_runner:/);
      const show = await git(bare, ['show', 'omnexx/auto-main:src/adder.ts']);
      expect(show.stdout).toContain('return a + b;');
      const testShow = await git(bare, ['show', 'omnexx/auto-main:test/adder.test.ts']);
      expect(testShow.stdout).toContain('add(-1, 1)');

      // Budget: all 5 model calls were recorded into the ledger (1 planner +
      // 4 executor turns), so the gate's caps can actually see the spend.
      const ledger = new JsonFileBudgetLedger(join(repo, '.omnexx', 'budget_ledger.json'));
      const entries = ledger.entries();
      expect(entries).toHaveLength(5);
      expect(entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(7500);
      expect(entries.every((e) => e.taskId === task.taskId)).toBe(true);
      expect(entries.reduce((sum, e) => sum + e.usd, 0)).toBeGreaterThan(0);
    },
  );
});
