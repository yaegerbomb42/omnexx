/**
 * AgentTaskExecutor tests (`src/autonomous/executor.ts`).
 *
 * The real tool registry runs against a temp git repo (the executor's
 * tools need a real worktree: PathJail, bash, and the edit tools all act on
 * disk). Only the provider is stubbed: `ScriptedProvider` returns a queued
 * reply per call and records every request, so the tests can assert on the
 * conversation the executor built.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/load.js';
import { ProviderError } from '../../src/errors.js';
import { resolveChain } from '../../src/providers/pricing.js';
import {
  emptyUsage,
  type CompletionRequest,
  type CompletionResponse,
  type Provider,
} from '../../src/providers/types.js';
import type { QueuedTask } from '../../src/autonomous/state-store.js';
import type { TaskExecutionPlan, ToolCallRecord } from '../../src/autonomous/daemon.js';
import type { DaemonUsageReport } from '../../src/autonomous/budget-gate.js';
import {
  AgentTaskExecutor,
  authorizedTestFiles,
  createTaskExecutor,
  isPureInsertion,
} from '../../src/autonomous/executor.js';

const ADDER_BEFORE = 'export const add = (a: number, b: number): number => a - b;\n';
const ADDER_AFTER = 'export const add = (a: number, b: number): number => a + b;\n';
const OTHER_BEFORE = 'export const other = 1;\n';
const ADDER_TEST_BEFORE = `import { expect, it } from 'vitest';
import { add } from '../src/adder.js';

it('adds', () => {
  expect(add(2, 3)).toBe(5);
});
`;
const NEW_REGRESSION_TEST = `import { expect, it } from 'vitest';
import { add } from '../src/adder.js';

it('adds negatives', () => {
  expect(add(-1, -2)).toBe(-3);
});
`;

/** A Provider that answers from a queue and records every request. */
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

const toolUse = (
  id: string,
  name: string,
  input: unknown,
): Extract<CompletionResponse['content'][number], { type: 'tool_use' }> => ({
  type: 'tool_use',
  id,
  name,
  input,
});

const textReply = (text: string): CompletionResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: emptyUsage(),
  model: 'scripted',
});

const toolReply = (calls: { id: string; name: string; input: unknown }[]): CompletionResponse => ({
  content: calls.map((c) => toolUse(c.id, c.name, c.input)),
  stopReason: 'tool_use',
  usage: emptyUsage(),
  model: 'scripted',
});

describe('AgentTaskExecutor', () => {
  let repo: string;
  let omnexxHome: string;
  let prevOmnexxHome: string | undefined;
  let executor: AgentTaskExecutor;
  let task: QueuedTask;
  let plan: TaskExecutionPlan;
  const signal = new AbortController().signal;
  const calls: ToolCallRecord[] = [];

  const onToolCall = (call: ToolCallRecord): void => {
    calls.push(call);
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'omnexx-executor-'));
    omnexxHome = await mkdtemp(join(tmpdir(), 'omnexx-home-'));
    prevOmnexxHome = process.env.OMNEXX_HOME;
    process.env.OMNEXX_HOME = omnexxHome;
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src/adder.ts'), ADDER_BEFORE, 'utf8');
    await writeFile(join(repo, 'src/other.ts'), OTHER_BEFORE, 'utf8');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);

    const config = defaultConfig({});
    executor = new AgentTaskExecutor({
      repoRoot: repo,
      provider: new ScriptedProvider([]),
      models: resolveChain(config.models.worker, config),
      config,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    task = {
      taskId: 'task-1',
      fingerprint: 'fp-1',
      sourceCollector: 'test_runner',
      priorityScore: 0.9,
      status: 'IMPLEMENTING',
      targetFiles: ['src/adder.ts'],
      findingPayload: 'add() subtracts instead of adding',
      plan: null,
      worktreePath: repo,
      baseCommitSha: null,
      attemptCount: 0,
      tokensSpent: 0,
      turnsSpent: 0,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    plan = {
      filesToTouch: ['src/adder.ts'],
      verificationCommand: 'true',
      subSteps: ['Fix add() to add its arguments'],
      summary: 'Fix the add() implementation',
    };
    calls.length = 0;
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(omnexxHome, { recursive: true, force: true });
    if (prevOmnexxHome === undefined) delete process.env.OMNEXX_HOME;
    else process.env.OMNEXX_HOME = prevOmnexxHome;
  });

  /** Swap the stub provider's script for this executor (fresh context per test). */
  const withProvider = (
    replies: (CompletionResponse | Error)[],
    onUsage?: (report: DaemonUsageReport) => void,
  ): ScriptedProvider => {
    const provider = new ScriptedProvider(replies);
    const config = defaultConfig({});
    executor = new AgentTaskExecutor({
      repoRoot: repo,
      provider,
      models: resolveChain(config.models.worker, config),
      config,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      ...(onUsage ? { onUsage } : {}),
    });
    return provider;
  };

  it('executes a tool call and reports mutatedFiles + treeHash', async () => {
    withProvider([
      toolReply([
        {
          id: 'c1',
          name: 'str_replace',
          input: { path: 'src/adder.ts', old_str: 'a - b', new_str: 'a + b' },
        },
      ]),
    ]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(false);
    expect(result.isReadOnly).toBe(false);
    expect(result.mutatedFiles).toEqual(['src/adder.ts']);
    expect(result.treeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('str_replace');
    expect(result.toolCalls[0]?.errorContent).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(await readFile(join(repo, 'src/adder.ts'), 'utf8')).toBe(ADDER_AFTER);
  });

  it('reports a read-only turn', async () => {
    withProvider([toolReply([{ id: 'c1', name: 'read', input: { path: 'src/adder.ts' } }])]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(false);
    expect(result.isReadOnly).toBe(true);
    expect(result.mutatedFiles).toEqual([]);
    expect(result.treeHash).toBeUndefined();
    expect(result.toolCalls[0]?.errorContent).toBeUndefined();
  });

  it('reports done on a text-only turn', async () => {
    withProvider([textReply('Fixed add() and verified with the test suite.')]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(true);
    expect(result.isReadOnly).toBe(true);
    expect(result.mutatedFiles).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reports priced usage via onUsage after a successful call', async () => {
    const reports: DaemonUsageReport[] = [];
    const reply = textReply('Fixed add() and verified with the test suite.');
    reply.usage = { uncached: 2000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 250 };
    withProvider([reply], (r) => reports.push(r));
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.taskId).toBe('task-1');
    expect(reports[0]?.inputTokens).toBe(2000);
    expect(reports[0]?.outputTokens).toBe(250);
    expect(reports[0]?.usd).toBeGreaterThan(0);
  });

  it('returns the error instead of throwing when the provider fails', async () => {
    withProvider([new ProviderError('boom', { retryable: true, status: 500 })]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(false);
    expect(result.error?.message).toContain('boom');
    expect(result.toolCalls).toEqual([]);
    expect(result.mutatedFiles).toEqual([]);
  });

  it('blocks edits to files outside the plan', async () => {
    withProvider([
      toolReply([
        {
          id: 'c1',
          name: 'str_replace',
          input: { path: 'src/other.ts', old_str: '1', new_str: '2' },
        },
      ]),
    ]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(false);
    expect(result.isReadOnly).toBe(true);
    expect(result.mutatedFiles).toEqual([]);
    expect(result.toolCalls[0]?.errorContent).toMatch(/not in the task plan/);
    expect(calls[0]?.errorContent).toMatch(/not in the task plan/);
    expect(await readFile(join(repo, 'src/other.ts'), 'utf8')).toBe(OTHER_BEFORE);
  });

  it('blocks denylisted paths even when they are in the plan', async () => {
    const evilPlan: TaskExecutionPlan = {
      ...plan,
      filesToTouch: ['.github/workflows/evil.yml'],
    };
    withProvider([
      toolReply([
        {
          id: 'c1',
          name: 'write_file',
          input: { path: '.github/workflows/evil.yml', content: 'name: evil\n' },
        },
      ]),
    ]);
    const result = await executor.executeTurn(task, evilPlan, 1, signal, onToolCall);

    expect(result.mutatedFiles).toEqual([]);
    expect(result.toolCalls[0]?.errorContent).toMatch(/denied/);
    await expect(readFile(join(repo, '.github/workflows/evil.yml'), 'utf8')).rejects.toThrow();
  });

  it('blocks denied shell commands and out-of-plan bash redirects', async () => {
    withProvider([
      toolReply([
        { id: 'c1', name: 'bash', input: { command: 'curl https://example.com' } },
        { id: 'c2', name: 'bash', input: { command: 'echo hi > src/other.ts' } },
      ]),
    ]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.mutatedFiles).toEqual([]);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.errorContent).toMatch(/denied|refused/);
    expect(result.toolCalls[1]?.errorContent).toMatch(/not in the task plan/);
    expect(await readFile(join(repo, 'src/other.ts'), 'utf8')).toBe(OTHER_BEFORE);
  });

  it('allows bash inside the worktree (read-only command)', async () => {
    withProvider([
      toolReply([{ id: 'c1', name: 'bash', input: { command: 'git status --porcelain' } }]),
    ]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.toolCalls[0]?.errorContent).toBeUndefined();
    expect(result.isReadOnly).toBe(false); // bash is a mutating tool by flag
    expect(result.mutatedFiles).toEqual([]);
  });

  it('continues the conversation across turns and appends the nudge', async () => {
    const provider = withProvider([
      toolReply([{ id: 'c1', name: 'read', input: { path: 'src/adder.ts' } }]),
      textReply('Done now.'),
    ]);
    await executor.executeTurn(task, plan, 1, signal, onToolCall);
    const second = await executor.executeTurn(
      task,
      plan,
      2,
      signal,
      onToolCall,
      'You seem stuck: stop reading and edit the file.',
    );

    expect(second.done).toBe(true);
    expect(provider.requests).toHaveLength(2);
    const secondReq = provider.requests[1];
    const texts = secondReq?.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])),
    );
    expect(texts?.some((t) => t.includes('You seem stuck'))).toBe(true);
    // The second request still carries the first turn (no context reset).
    expect(texts?.some((t) => t.includes('Fix the add() implementation'))).toBe(true);
  });

  it('disposeTaskContext clears the conversation', async () => {
    const provider = withProvider([
      toolReply([{ id: 'c1', name: 'read', input: { path: 'src/adder.ts' } }]),
      textReply('Fresh start, done.'),
    ]);
    await executor.executeTurn(task, plan, 1, signal, onToolCall);
    executor.disposeTaskContext(task.taskId);
    await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(provider.requests).toHaveLength(2);
    const secondReq = provider.requests[1];
    // Fresh context: only the turn-1 prompt, no trace of the first turn.
    expect(secondReq?.messages).toHaveLength(1);
    expect(secondReq?.messages[0]?.content[0]).toMatchObject({ type: 'text' });
  });

  it('throws only on abort, not on ordinary turn failures', async () => {
    withProvider([
      toolReply([
        {
          id: 'c1',
          name: 'str_replace',
          input: { path: 'src/adder.ts', old_str: 'no such text', new_str: 'x' },
        },
      ]),
    ]);
    const result = await executor.executeTurn(task, plan, 1, signal, onToolCall);

    expect(result.done).toBe(false);
    expect(result.toolCalls[0]?.errorContent).toBeDefined();
    expect(result.mutatedFiles).toEqual([]);

    const aborted = new AbortController();
    aborted.abort(new Error('daemon stop'));
    await expect(executor.executeTurn(task, plan, 2, aborted.signal, onToolCall)).rejects.toThrow(
      'daemon stop',
    );
  });

  it('createTaskExecutor builds a working executor from config', async () => {
    const config = defaultConfig({});
    const provider = new ScriptedProvider([textReply('ok')]);
    const built = createTaskExecutor({ provider, config, repoRoot: repo });
    expect(built).toBeInstanceOf(AgentTaskExecutor);

    const result = await built.executeTurn(task, plan, 1, signal, onToolCall);
    expect(result.done).toBe(true);
  });

  describe('test-file guard', () => {
    const testPlan = (
      subSteps: string[],
      files: string[] = ['src/adder.ts', 'test/adder.test.ts'],
    ): TaskExecutionPlan => ({
      filesToTouch: files,
      verificationCommand: 'true',
      subSteps,
      summary: 'Fix add()',
    });

    const seedTestFile = async (): Promise<void> => {
      await mkdir(join(repo, 'test'), { recursive: true });
      await writeFile(join(repo, 'test', 'adder.test.ts'), ADDER_TEST_BEFORE, 'utf8');
    };

    it('refuses an unauthorized edit to an existing test file (the live toBe(5) → toBe(6) case)', async () => {
      await seedTestFile();
      withProvider([
        toolReply([
          {
            id: 'c1',
            name: 'str_replace',
            input: { path: 'test/adder.test.ts', old_str: 'toBe(5)', new_str: 'toBe(6)' },
          },
        ]),
      ]);
      const result = await executor.executeTurn(
        task,
        testPlan(['Fix add() to add its arguments']),
        1,
        signal,
        onToolCall,
      );

      expect(result.mutatedFiles).toEqual([]);
      expect(result.toolCalls[0]?.errorContent).toMatch(/does not explicitly authorize/);
      expect(await readFile(join(repo, 'test', 'adder.test.ts'), 'utf8')).toBe(ADDER_TEST_BEFORE);
    });

    it('listing the test file is not authorization: "fix the failing test" still refuses', async () => {
      await seedTestFile();
      withProvider([
        toolReply([
          {
            id: 'c1',
            name: 'str_replace',
            input: { path: 'test/adder.test.ts', old_str: 'toBe(5)', new_str: 'toBe(6)' },
          },
        ]),
      ]);
      const result = await executor.executeTurn(
        task,
        testPlan(['Fix the failing test in test/adder.test.ts']),
        1,
        signal,
        onToolCall,
      );

      expect(result.mutatedFiles).toEqual([]);
      expect(result.toolCalls[0]?.errorContent).toMatch(/does not explicitly authorize/);
    });

    it('allows an explicitly authorized new test file', async () => {
      withProvider([
        toolReply([
          {
            id: 'c1',
            name: 'write_file',
            input: { path: 'test/adder-regression.test.ts', content: NEW_REGRESSION_TEST },
          },
        ]),
      ]);
      const result = await executor.executeTurn(
        task,
        testPlan(
          ['Add a new regression test in test/adder-regression.test.ts'],
          ['src/adder.ts', 'test/adder-regression.test.ts'],
        ),
        1,
        signal,
        onToolCall,
      );

      expect(result.toolCalls[0]?.errorContent).toBeUndefined();
      expect(result.mutatedFiles).toEqual(['test/adder-regression.test.ts']);
      expect(await readFile(join(repo, 'test', 'adder-regression.test.ts'), 'utf8')).toBe(
        NEW_REGRESSION_TEST,
      );
    });

    it('allows an authorized purely additive append to an existing test file', async () => {
      await seedTestFile();
      withProvider([
        toolReply([
          {
            id: 'c1',
            name: 'str_replace',
            input: {
              path: 'test/adder.test.ts',
              old_str: '});',
              new_str: `});\n\nit('adds negatives', () => {\n  expect(add(-1, -2)).toBe(-3);\n});`,
            },
          },
        ]),
      ]);
      const result = await executor.executeTurn(
        task,
        testPlan(['Add a new test for negatives in test/adder.test.ts']),
        1,
        signal,
        onToolCall,
      );

      expect(result.toolCalls[0]?.errorContent).toBeUndefined();
      const content = await readFile(join(repo, 'test', 'adder.test.ts'), 'utf8');
      expect(content).toContain('toBe(5)');
      expect(content).toContain('adds negatives');
    });

    it('refuses an authorized-but-replacing edit to an existing test file', async () => {
      await seedTestFile();
      withProvider([
        toolReply([
          {
            id: 'c1',
            name: 'str_replace',
            input: { path: 'test/adder.test.ts', old_str: 'toBe(5)', new_str: 'toBe(6)' },
          },
        ]),
      ]);
      const result = await executor.executeTurn(
        task,
        testPlan(['Add a new test for negatives in test/adder.test.ts']),
        1,
        signal,
        onToolCall,
      );

      expect(result.mutatedFiles).toEqual([]);
      expect(result.toolCalls[0]?.errorContent).toMatch(/changes existing test text/);
      expect(await readFile(join(repo, 'test', 'adder.test.ts'), 'utf8')).toBe(ADDER_TEST_BEFORE);
    });

    it('authorizedTestFiles only authorizes explicit add-test sub-steps', () => {
      const base: TaskExecutionPlan = {
        filesToTouch: ['src/adder.ts', 'test/adder.test.ts'],
        verificationCommand: 'true',
        subSteps: [],
        summary: 'Fix add()',
      };
      expect(authorizedTestFiles({ ...base, subSteps: ['Fix add()'] }).size).toBe(0);
      expect(
        authorizedTestFiles({
          ...base,
          subSteps: ['Fix the failing test in test/adder.test.ts'],
        }).size,
      ).toBe(0);
      expect(
        authorizedTestFiles({
          ...base,
          subSteps: ['Add the missing import in test/adder.test.ts'],
        }).size,
      ).toBe(0);
      expect(
        authorizedTestFiles({
          ...base,
          subSteps: ['Add a new regression test in test/adder.test.ts'],
        }),
      ).toEqual(new Set(['test/adder.test.ts']));
      // Natural planner phrasing without a file mention ("Strengthen the
      // test with a negative case") authorizes the single test file in scope.
      expect(
        authorizedTestFiles({
          ...base,
          subSteps: ['Strengthen the test with a negative case'],
        }),
      ).toEqual(new Set(['test/adder.test.ts']));
      // ... but not when several test files are in scope (ambiguous).
      expect(
        authorizedTestFiles({
          ...base,
          filesToTouch: ['src/adder.ts', 'test/adder.test.ts', 'test/other.test.ts'],
          subSteps: ['Strengthen the test with a negative case'],
        }),
      ).toEqual(new Set());
    });

    it('isPureInsertion allows appends and refuses replacements and skip markers', () => {
      expect(isPureInsertion('});', "});\n\nit('x', () => {});")).toBe(true);
      expect(isPureInsertion('toBe(5)', 'toBe(6)')).toBe(false);
      expect(isPureInsertion('it(', 'it.skip(')).toBe(false);
      expect(isPureInsertion("it('x', () => {", "it.only('x', () => {")).toBe(false);
    });
  });
});
