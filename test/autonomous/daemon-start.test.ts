/**
 * Wiring tests for `omnexx daemon start`: the budget-gate adapter, the
 * collaborator builder, and the fail-fast no-key path.
 *
 * No test here needs a real API key or starts a daemon: `buildDaemonCollaborators`
 * is exercised with stub planner/executor factories (plus one test proving the
 * default factories build the real classes), and `daemonStart` is only
 * driven as far as its key check (which must fail before any daemon exists).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildDaemonBudgetGate, createDaemonBudgetGate } from '../../src/autonomous/budget-gate.js';
import { AutonomousDaemon } from '../../src/autonomous/daemon.js';
import type { ArchitectPlanner, TaskExecutor } from '../../src/autonomous/daemon.js';
import { resolveAutonomousPaths, writeDaemonControl } from '../../src/autonomous/state.js';
import { AutonomousStateStore } from '../../src/autonomous/state-store.js';
import { buildDaemonCollaborators, daemonStart } from '../../src/cli/commands/daemon.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import type { CliIO } from '../../src/cli/io.js';
import { defaultConfig } from '../../src/config/load.js';
import {
  DaemonBudgetGovernor,
  DEFAULT_DAEMON_CAPS,
  MemoryBudgetLedger,
  type LedgerEntry,
} from '../../src/core/budgetGovernor.js';
import type { Provider } from '../../src/providers/types.js';
import { isolatedEnv, tempDir, tempRepo } from '../support/tmp.js';

const fakeProvider: Provider = {
  name: 'fake',
  complete: () => Promise.reject(new Error('fake provider: no completions')),
};

const fakePlanner: ArchitectPlanner = {
  plan: () =>
    Promise.resolve({
      filesToTouch: [],
      verificationCommand: 'npm test',
      subSteps: [],
      summary: 'fake plan',
    }),
};

const fakeExecutor: TaskExecutor = {
  executeTurn: () =>
    Promise.resolve({ done: true, isReadOnly: false, mutatedFiles: [], toolCalls: [] }),
};

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

function makeIo(
  cwd: string,
  env: NodeJS.ProcessEnv,
): { io: CliIO; stdout: () => string; stderr: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    io: {
      stdout,
      stderr,
      stdin: Readable.from([]),
      env,
      cwd,
      isTTY: false,
    },
    stdout: collect(stdout),
    stderr: collect(stderr),
  };
}

describe('daemon budget gate', () => {
  it('reports ok on an empty ledger', async () => {
    const governor = new DaemonBudgetGovernor({
      ledger: new MemoryBudgetLedger(),
      priceCard: {},
      caps: DEFAULT_DAEMON_CAPS,
    });
    const gate = createDaemonBudgetGate(governor, {
      hourTokens: 1_000_000,
      hourUsd: 3,
      dayTokens: 10_000_000,
      dayUsd: 25,
    });
    await expect(gate.check(Date.now())).resolves.toEqual({ ok: true });
  });

  it('reports not-ok with a reason when the daily USD cap is reached', async () => {
    const ledger = new MemoryBudgetLedger();
    const now = Date.now();
    // Two hours ago: outside the hourly window, inside the daily one, so the
    // daily cap (not the hourly cap) is the one that trips.
    const entry: LedgerEntry = {
      at: now - 2 * 3_600_000,
      usd: 30,
      tokens: 10,
      taskId: 't1',
      shipped: false,
    };
    ledger.record(entry);
    const governor = new DaemonBudgetGovernor({ ledger, priceCard: {}, caps: DEFAULT_DAEMON_CAPS });
    const gate = createDaemonBudgetGate(governor, {
      hourTokens: 1_000_000,
      hourUsd: 3,
      dayTokens: 10_000_000,
      dayUsd: 25,
    });
    const result = await gate.check(now);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/daily spend cap reached/);
  });

  it('reports not-ok with a reason when the hourly token cap is reached', async () => {
    const ledger = new MemoryBudgetLedger();
    const now = Date.now();
    ledger.record({ at: now, usd: 0.01, tokens: 1_000_000, taskId: 't1', shipped: false });
    const governor = new DaemonBudgetGovernor({ ledger, priceCard: {}, caps: DEFAULT_DAEMON_CAPS });
    const gate = createDaemonBudgetGate(governor, {
      hourTokens: 1_000_000,
      hourUsd: 3,
      dayTokens: 10_000_000,
      dayUsd: 25,
    });
    const result = await gate.check(now);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hourly token cap reached/);
  });

  it('reports not-ok when the circuit breaker is open, even with no spend', async () => {
    const gate = createDaemonBudgetGate(
      {
        windowUsage: () => ({ hourTokens: 0, hourUsd: 0, dayTokens: 0, dayUsd: 0 }),
        isCircuitOpen: () => true,
      },
      { hourTokens: 1_000_000, hourUsd: 3, dayTokens: 10_000_000, dayUsd: 25 },
    );
    const result = await gate.check(Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/circuit breaker open/);
  });

  it('applies the --max-cost-day override to the daily USD cap', async () => {
    const dir = await tempDir('omnexx-budget-gate-');
    const ledgerPath = join(dir, 'budget_ledger.json');
    await mkdir(dir, { recursive: true });
    await writeFile(
      ledgerPath,
      JSON.stringify([{ at: Date.now(), usd: 1, tokens: 10, taskId: 't1', shipped: false }]),
    );
    const budget = defaultConfig().autonomous.budget;
    const now = Date.now();

    const overridden = buildDaemonBudgetGate({
      repoRoot: dir,
      budget,
      maxCostDayUsd: 0.01,
      ledgerPath,
    });
    expect(overridden.caps.dayUsd).toBe(0.01);
    const blocked = await overridden.gate.check(now);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/daily spend cap reached/);

    const plain = buildDaemonBudgetGate({ repoRoot: dir, budget, ledgerPath });
    expect(plain.caps.dayUsd).toBe(25);
    await expect(plain.gate.check(now)).resolves.toEqual({ ok: true });
  });
});

describe('buildDaemonCollaborators', () => {
  it('wires every collaborator, with the target-branch override reaching the shipper', async () => {
    const repo = await tempRepo();
    const config = defaultConfig({ autonomous: { enabled: true } });
    const paths = resolveAutonomousPaths(repo, config.autonomous);
    const store = new AutonomousStateStore({ repoRoot: repo, dbPath: paths.dbPath });
    await store.open();
    try {
      const collaborators = await buildDaemonCollaborators({
        repoRoot: repo,
        config,
        paths,
        store,
        provider: fakeProvider,
        targetBranch: 'omnexx/auto-test',
        plannerFactory: () => fakePlanner,
        executorFactory: () => fakeExecutor,
      });
      expect(collaborators.discovery).toBeDefined();
      expect(collaborators.triage).toBeDefined();
      expect(collaborators.planner).toBe(fakePlanner);
      expect(collaborators.executor).toBe(fakeExecutor);
      expect(collaborators.verifier).toBeDefined();
      expect(collaborators.shipper).toBeDefined();
      expect(collaborators.worktrees).toBeDefined();
      expect(collaborators.qualityRatchet).toBeDefined();
      expect(collaborators.budget).toBeDefined();
      expect(collaborators.governor).toBeDefined();
      // The shipper's target branch is private; read it back structurally to
      // prove the --target-branch override actually reaches the shipper.
      const targetBranch = (collaborators.shipper as unknown as { targetBranch: string })
        .targetBranch;
      expect(targetBranch).toBe('omnexx/auto-test');
      await expect(collaborators.budget.check(Date.now())).resolves.toEqual({ ok: true });
    } finally {
      store.close();
    }
  });

  it('builds the real planner and executor with the default factories', async () => {
    const repo = await tempRepo();
    const config = defaultConfig({ autonomous: { enabled: true } });
    const paths = resolveAutonomousPaths(repo, config.autonomous);
    const store = new AutonomousStateStore({ repoRoot: repo, dbPath: paths.dbPath });
    await store.open();
    try {
      const collaborators = await buildDaemonCollaborators({
        repoRoot: repo,
        config,
        paths,
        store,
        provider: fakeProvider,
      });
      // Real classes, not stubs: the default factories are static imports of
      // the sibling planner/executor modules.
      expect(collaborators.planner.constructor.name).toBe('LlmArchitectPlanner');
      expect(collaborators.executor.constructor.name).toBe('AgentTaskExecutor');
    } finally {
      store.close();
    }
  });

  it('records planner usage into the budget ledger, so the gate can trip', async () => {
    const repo = await tempRepo();
    const config = defaultConfig({ autonomous: { enabled: true } });
    // Tiny hourly token cap: one planner call must trip it.
    config.autonomous.budget.max_tokens_per_hour = 1;
    const paths = resolveAutonomousPaths(repo, config.autonomous);
    const store = new AutonomousStateStore({ repoRoot: repo, dbPath: paths.dbPath });
    await store.open();
    const ledger = new MemoryBudgetLedger();
    const planProvider: Provider = {
      name: 'plan-scripted',
      complete: () =>
        Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                filesToTouch: ['src/adder.ts'],
                verificationCommand: 'npx vitest run test/adder.test.ts',
                subSteps: ['fix the adder'],
                summary: 'Fix the adder',
              }),
            },
          ],
          stopReason: 'end_turn',
          usage: { uncached: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 },
          model: 'scripted',
        }),
    };
    try {
      const collaborators = await buildDaemonCollaborators({
        repoRoot: repo,
        config,
        paths,
        store,
        provider: planProvider,
        ledger,
      });
      await expect(collaborators.budget.check(Date.now())).resolves.toEqual({ ok: true });
      const plan = await collaborators.planner.plan({
        taskId: 'task-ledger',
        fingerprint: 'fp-ledger',
        sourceCollector: 'test_runner',
        priorityScore: 0.9,
        status: 'QUEUED',
        targetFiles: ['src/adder.ts'],
        findingPayload: { test: 'test/adder.test.ts', error: 'expected 3, got 4' },
        plan: null,
        worktreePath: null,
        baseCommitSha: null,
        attemptCount: 0,
        tokensSpent: 0,
        turnsSpent: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      });
      expect(plan.summary).toBe('Fix the adder');
      // The planner's priced call landed in the ledger (1 entry, 1500 tokens).
      expect(ledger.entries()).toHaveLength(1);
      expect(ledger.entries()[0]?.tokens).toBe(1500);
      expect(ledger.entries()[0]?.taskId).toBe('task-ledger');
      // ...and the gate now sees it: the 1-token hourly cap is exceeded.
      const check = await collaborators.budget.check(Date.now());
      expect(check.ok).toBe(false);
      expect(check.reason).toContain('hourly token cap');
    } finally {
      store.close();
    }
  });
});

describe('daemon control-file polling', () => {
  it('pauses on a pause control file and resumes on a resume control file', async () => {
    const repo = await tempRepo();
    const config = defaultConfig({ autonomous: { enabled: true } });
    const paths = resolveAutonomousPaths(repo, config.autonomous);
    const store = new AutonomousStateStore({ repoRoot: repo, dbPath: paths.dbPath });
    writeDaemonControl(paths.controlPath, 'pause');
    const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
    const daemon = new AutonomousDaemon({
      repoRoot: repo,
      store,
      controlPath: paths.controlPath,
      idleSleepBaseMs: 100,
      idleSleepMaxMs: 1000,
      headPollMs: 10,
      logger: silent,
    });
    const run = daemon.start({ maxCycles: 2 });
    const deadline = Date.now() + 5000;
    while (!daemon.isPaused && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(daemon.isPaused).toBe(true);
    writeDaemonControl(paths.controlPath, 'resume');
    await run;
    expect(daemon.isPaused).toBe(false);
  });
});

describe('daemonStart', () => {
  it('refuses to start without a model key, with an actionable error', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'omnexx.toml'), '[autonomous]\nenabled = true\n');
    const env = await isolatedEnv();
    const { io, stderr } = makeIo(repo, env);
    const code = await daemonStart(io, {});
    expect(code).toBe(EXIT.error);
    expect(stderr()).toContain('ANTHROPIC_API_KEY');
  });

  it('refuses to start when autonomous is disabled', async () => {
    const repo = await tempRepo();
    const env = await isolatedEnv();
    const { io, stderr } = makeIo(repo, env);
    const code = await daemonStart(io, {});
    expect(code).toBe(EXIT.error);
    expect(stderr()).toContain('disabled');
  });

  it('rejects a non-numeric --max-cost-day before touching the provider', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'omnexx.toml'), '[autonomous]\nenabled = true\n');
    const env = await isolatedEnv();
    const { io, stderr } = makeIo(repo, env);
    const code = await daemonStart(io, { maxCostDay: 'not-a-number' });
    expect(code).toBe(EXIT.error);
    expect(stderr()).toContain('--max-cost-day');
  });
});
