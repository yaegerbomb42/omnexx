/**
 * Tests for the LLM-backed Architect planner (`src/autonomous/planner.ts`).
 *
 * The provider is stubbed with canned replies served in order, so every
 * case is deterministic: valid JSON, fenced JSON, malformed-then-valid
 * (retry), and plans that must be clamped or rejected. No filesystem or
 * network access.
 */
import { describe, expect, it } from 'vitest';
import type { DaemonUsageReport } from '../../src/autonomous/budget-gate.js';
import {
  createArchitectPlanner,
  LlmArchitectPlanner,
  MAX_PLANNER_ATTEMPTS,
  type PlannerLogger,
} from '../../src/autonomous/planner.js';
import type { QueuedTask } from '../../src/autonomous/state-store.js';
import type { ResolvedModel } from '../../src/providers/pricing.js';
import {
  emptyUsage,
  type CompletionRequest,
  type CompletionResponse,
  type Provider,
} from '../../src/providers/types.js';
import type { OmnexxConfig } from '../../src/config/schema.js';

const silentLogger: PlannerLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const ZERO_PRICE = {
  id: 'mock',
  input: 0,
  output: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_read: 0,
};

function model(id: string, provider = 'mock'): ResolvedModel {
  return { provider, alias: id, id, price: { ...ZERO_PRICE, id } };
}

/** A provider that serves canned replies (or throws) in call order. */
class CannedProvider implements Provider {
  readonly name = 'canned';
  readonly requests: CompletionRequest[] = [];
  private readonly replies: (string | Error)[];
  private calls = 0;

  constructor(replies: (string | Error)[]) {
    this.replies = replies;
  }

  get callCount(): number {
    return this.calls;
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls++;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      content: [{ type: 'text', text: reply as string }],
      stopReason: 'end_turn',
      usage: emptyUsage(),
      model: req.model,
    });
  }
}

function makeTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    taskId: 'task-1',
    fingerprint: 'fp-1',
    sourceCollector: 'test-runner',
    priorityScore: 80,
    status: 'QUEUED',
    targetFiles: ['src/adder.ts', 'test/adder.test.ts'],
    findingPayload: { test: 'test/adder.test.ts', error: 'expected 3, got 4' },
    plan: null,
    worktreePath: null,
    baseCommitSha: null,
    attemptCount: 0,
    tokensSpent: 0,
    turnsSpent: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

const VALID_PLAN = JSON.stringify({
  filesToTouch: ['src/adder.ts', 'test/adder.test.ts'],
  verificationCommand: 'npx vitest run test/adder.test.ts',
  subSteps: ['reproduce the failure', 'fix the adder', 're-run the test'],
  summary: 'Fix the off-by-one in the adder',
});

function plannerFor(replies: (string | Error)[], models: ResolvedModel[] = [model('mock-1')]) {
  const provider = new CannedProvider(replies);
  const planner = new LlmArchitectPlanner({ provider, models, logger: silentLogger });
  return { provider, planner };
}

describe('LlmArchitectPlanner.plan', () => {
  it('returns a valid plan from raw JSON', async () => {
    const { planner } = plannerFor([VALID_PLAN]);
    const plan = await planner.plan(makeTask());
    expect(plan.filesToTouch).toEqual(['src/adder.ts', 'test/adder.test.ts']);
    expect(plan.verificationCommand).toBe('npx vitest run test/adder.test.ts');
    expect(plan.subSteps).toHaveLength(3);
    expect(plan.summary).toBe('Fix the off-by-one in the adder');
  });

  it('extracts JSON from a fenced code block', async () => {
    const { planner } = plannerFor([`Here is the plan:\n\`\`\`json\n${VALID_PLAN}\n\`\`\`\n`]);
    const plan = await planner.plan(makeTask());
    expect(plan.filesToTouch).toEqual(['src/adder.ts', 'test/adder.test.ts']);
  });

  it('retries once on malformed JSON, then accepts the valid reply', async () => {
    const { provider, planner } = plannerFor(['not json at all', VALID_PLAN]);
    const plan = await planner.plan(makeTask());
    expect(plan.summary).toBe('Fix the off-by-one in the adder');
    expect(provider.callCount).toBe(2);
  });

  it('throws after repeated malformed output instead of fabricating a plan', async () => {
    const { provider, planner } = plannerFor(['garbage', 'still garbage', '{bad json']);
    await expect(planner.plan(makeTask())).rejects.toThrow(/no valid plan for task task-1/);
    expect(provider.callCount).toBe(MAX_PLANNER_ATTEMPTS);
  });

  it('throws when the provider keeps failing', async () => {
    const { planner } = plannerFor([new Error('boom'), new Error('boom'), new Error('boom')]);
    await expect(planner.plan(makeTask())).rejects.toThrow(/no valid plan for task task-1/);
  });

  it('clamps files to 6 and sub-steps to 5', async () => {
    const targets = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const reply = JSON.stringify({
      filesToTouch: targets,
      verificationCommand: 'npm run typecheck',
      subSteps: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
      summary: 'Touch everything',
    });
    const { planner } = plannerFor([reply]);
    const plan = await planner.plan(makeTask({ targetFiles: targets }));
    expect(plan.filesToTouch).toHaveLength(6);
    expect(plan.subSteps).toHaveLength(5);
  });

  it('drops files outside the task targets and rejects a plan with none left', async () => {
    const invented = JSON.stringify({
      filesToTouch: ['src/adder.ts', 'src/totally-made-up.ts', '/etc/passwd'],
      verificationCommand: 'npm run typecheck',
      subSteps: ['do the thing'],
      summary: 'Mixed plan',
    });
    const { planner } = plannerFor([invented]);
    const plan = await planner.plan(makeTask());
    expect(plan.filesToTouch).toEqual(['src/adder.ts']);

    const withTest = JSON.stringify({
      filesToTouch: ['src/adder.ts', 'test/adder.test.ts', 'src/invented.ts'],
      verificationCommand: 'npx vitest run test/adder.test.ts',
      subSteps: ['Add new test in test/adder.test.ts'],
      summary: 'Add test for adder',
    });
    const { planner: plannerWithTest } = plannerFor([withTest]);
    const planWithTest = await plannerWithTest.plan(makeTask());
    expect(planWithTest.filesToTouch).toEqual(['src/adder.ts', 'test/adder.test.ts']);

    const allInvented = JSON.stringify({
      filesToTouch: ['src/nope.ts'],
      verificationCommand: 'npm run typecheck',
      subSteps: ['do the thing'],
      summary: 'Invented plan',
    });
    const { planner: planner2 } = plannerFor([allInvented, allInvented, allInvented]);
    await expect(planner2.plan(makeTask())).rejects.toThrow(/no known target file/);
  });

  it('accepts model-chosen files when the task has no known targets', async () => {
    const { planner } = plannerFor([VALID_PLAN]);
    const plan = await planner.plan(makeTask({ targetFiles: [] }));
    expect(plan.filesToTouch).toEqual(['src/adder.ts', 'test/adder.test.ts']);
  });

  it('rejects an empty files list and a missing verification command', async () => {
    const noFiles = JSON.stringify({
      filesToTouch: [],
      verificationCommand: 'npm run typecheck',
      subSteps: ['do the thing'],
      summary: 'Empty files',
    });
    const { planner } = plannerFor([noFiles, noFiles, noFiles]);
    await expect(planner.plan(makeTask())).rejects.toThrow(/no filesToTouch|no known target file/);

    const noCommand = JSON.stringify({
      filesToTouch: ['src/adder.ts'],
      verificationCommand: '   ',
      subSteps: ['do the thing'],
      summary: 'No command',
    });
    const { planner: planner2 } = plannerFor([noCommand, noCommand, noCommand]);
    await expect(planner2.plan(makeTask())).rejects.toThrow(/no verificationCommand/);
  });

  it('rejects unsafe verification commands', async () => {
    const chained = JSON.stringify({
      filesToTouch: ['src/adder.ts'],
      verificationCommand: 'npx vitest run test/adder.test.ts && rm -rf /',
      subSteps: ['do the thing'],
      summary: 'Chained command',
    });
    const { planner } = plannerFor([chained, chained, chained]);
    await expect(planner.plan(makeTask())).rejects.toThrow(/unsafe/);
  });

  it('walks the model chain across attempts and routes by provider', async () => {
    const { provider, planner } = plannerFor(
      [new Error('first model down'), VALID_PLAN],
      [model('m1', 'provider-a'), model('m2', 'provider-b')],
    );
    const plan = await planner.plan(makeTask());
    expect(plan.summary).toBe('Fix the off-by-one in the adder');
    expect(provider.requests[0]?.model).toBe('m1');
    expect(provider.requests[0]?.route).toBe('provider-a');
    expect(provider.requests[1]?.model).toBe('m2');
    expect(provider.requests[1]?.route).toBe('provider-b');
  });

  it('sends the task metadata and finding, and never sends secrets', async () => {
    const { provider, planner } = plannerFor([VALID_PLAN]);
    await planner.plan(
      makeTask({
        findingPayload: { apiKey: 'sk-live-secret', detail: 'failing test' },
      }),
    );
    const text = provider.requests
      .flatMap((r) => [
        ...r.system.map((b) => b.text),
        ...r.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))),
      ])
      .join('\n');
    expect(text).toContain('task-1');
    expect(text).toContain('test-runner');
    expect(text).toContain('src/adder.ts');
    expect(text).not.toContain('sk-live-secret');
    expect(text).toContain('[redacted]');
  });

  it('throws at construction with no models', () => {
    const provider = new CannedProvider([VALID_PLAN]);
    expect(() => new LlmArchitectPlanner({ provider, models: [] })).toThrow(/no planner models/);
  });

  it('reports priced usage via onUsage after a successful call', async () => {
    const reports: DaemonUsageReport[] = [];
    const priced = model('mock-1');
    priced.price = {
      id: 'mock',
      input: 3,
      output: 15,
      cache_write_5m: 3.75,
      cache_write_1h: 7.5,
      cache_read: 0.3,
    };
    const provider: Provider = {
      name: 'canned-usage',
      complete: () =>
        Promise.resolve({
          content: [{ type: 'text', text: VALID_PLAN }],
          stopReason: 'end_turn',
          usage: { uncached: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 500 },
          model: 'mock-1',
        }),
    };
    const planner = new LlmArchitectPlanner({
      provider,
      models: [priced],
      logger: silentLogger,
      onUsage: (r) => reports.push(r),
    });
    await planner.plan(makeTask());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.taskId).toBe('task-1');
    expect(reports[0]?.inputTokens).toBe(1000);
    expect(reports[0]?.outputTokens).toBe(500);
    // (1000 × $3 + 500 × $15) / 1e6 per-million-token prices.
    expect(reports[0]?.usd).toBeCloseTo(0.0105, 10);
  });
});

describe('createArchitectPlanner', () => {
  it('resolves the planner chain from config.models.planner', () => {
    const provider = new CannedProvider([VALID_PLAN]);
    const config = {
      models: { planner: ['anthropic:sonnet', 'anthropic:haiku'] },
      providers: { endpoints: {} },
      pricing: {},
    } as unknown as OmnexxConfig;
    const planner = createArchitectPlanner({ provider, config, logger: silentLogger });
    // Resolved via resolveChain: provider + concrete id per ref.
    return planner.plan(makeTask()).then((plan) => {
      expect(plan.summary).toBe('Fix the off-by-one in the adder');
      expect(provider.requests[0]?.model).toBe('claude-sonnet-5-5');
      expect(provider.requests[0]?.route).toBe('anthropic');
    });
  });
});
