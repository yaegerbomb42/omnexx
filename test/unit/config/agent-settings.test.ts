import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentBriefFor,
  derivedAgentLayer,
  levelsOf,
  parseAgentSettings,
  readAgentSettings,
  writeAgentSettings,
} from '../../../src/config/agent-settings.js';
import { defaultConfig, loadConfig } from '../../../src/config/load.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const LEVELS = {
  taskEffort: 2,
  turnEffort: 7,
  contextLevel: 1,
  time: '30m' as const,
  maxTokens: 4_096,
};

describe('agent settings file', () => {
  it('cleans untrusted JSON: clamps levels, snaps tokens, defaults the rest', () => {
    const s = parseAgentSettings({
      levels: { taskEffort: 42, turnEffort: -1, time: 'forever', maxTokens: 5_000 },
      askOnStart: false,
    });
    expect(s).toEqual({
      levels: { taskEffort: 10, turnEffort: 1, contextLevel: 6, time: '2h', maxTokens: 4_096 },
      askOnStart: false,
    });
    expect(parseAgentSettings(null)).toEqual({ levels: undefined, askOnStart: true });
  });

  it('persists "ask again" and "don\'t ask again"', async () => {
    const paths = resolvePaths(await isolatedEnv());
    expect(await readAgentSettings(paths)).toEqual({ levels: undefined, askOnStart: true });
    await writeAgentSettings(paths, { levels: LEVELS, askOnStart: false });
    expect(await readAgentSettings(paths)).toEqual({ levels: LEVELS, askOnStart: false });
    await writeAgentSettings(paths, { levels: LEVELS, askOnStart: true });
    expect((await readAgentSettings(paths)).askOnStart).toBe(true);
  });

  it('changes nothing until levels are saved', async () => {
    const env = await isolatedEnv();
    const { config } = await loadConfig({ cwd: await tempDir(), env });
    const plain = defaultConfig();
    expect(config.plan).toEqual(plain.plan);
    expect(config.context).toEqual(plain.context);
    expect(config.budget.max_hours).toBe(plain.budget.max_hours);
    expect(levelsOf(config)).toBeUndefined();
    expect(agentBriefFor(config)).toBeUndefined();
  });

  it('drives plan, context, time and output cap from saved levels', async () => {
    const env = await isolatedEnv();
    await writeAgentSettings(resolvePaths(env), { levels: LEVELS, askOnStart: true });
    const { config } = await loadConfig({ cwd: await tempDir(), env });
    expect(config.agent).toMatchObject({ task_effort: 2, turn_effort: 7, context_level: 1 });
    expect(config.plan).toMatchObject({ mode: 'fast', loop_think_turns: 3, loop_rounds: 3 });
    expect(config.context).toMatchObject({
      compact_at: 4_250,
      budget_tokens: 5_000,
      compact_keep_turns: 1,
    });
    expect(config.context.sections.codemap).toBe('hidden');
    expect(config.budget.max_hours).toBe(0.5);
    expect(config.providers.anthropic.max_tokens).toBe(4_096);
    expect(agentBriefFor(config)).toMatch(/Effort per task: 2\/10/);
  });

  it('lets a project file and CLI flags override what the levels imply', async () => {
    const env = await isolatedEnv();
    const cwd = await tempDir();
    await writeAgentSettings(resolvePaths(env), { levels: LEVELS, askOnStart: true });
    await writeFile(join(cwd, 'omnexx.toml'), '[plan]\nloop_rounds = 9\n');
    const { config } = await loadConfig({ cwd, env, flags: { budget: { max_hours: 3 } } });
    expect(config.plan.loop_rounds).toBe(9);
    expect(config.plan.loop_think_turns).toBe(3);
    expect(config.budget.max_hours).toBe(3);
  });

  it('clamps the context budget to the worker model window when a profile names it', () => {
    const layer = derivedAgentLayer({
      agent: { context_level: 10 },
      models: { worker: ['groq:x'], profiles: { 'groq:x': { context: 128_000 } } },
    });
    expect(layer).toMatchObject({ context: { compact_at: 92_480, budget_tokens: 108_800 } });
    expect(derivedAgentLayer({ agent: {} })).toBeUndefined();
  });

  it('keeps the quick think-first loop for short goals at every effort level below full planning', async () => {
    const { tryFastPath } = await import('../../../src/core/fast-path.js');
    const { configSchema } = await import('../../../src/config/schema.js');
    for (const level of [1, 3, 6, 7]) {
      const layer = derivedAgentLayer({ agent: { task_effort: level } }) as {
        plan: Record<string, unknown>;
      };
      expect(layer.plan.milestones).toBeUndefined();
      const config = configSchema.parse({ plan: layer.plan });
      expect(tryFastPath(config, 'Fix the two bugs in the monthly report.')).toBe(true);
    }
    const capped = derivedAgentLayer({ agent: { task_effort: 6 } }) as {
      plan: Record<string, unknown>;
    };
    expect(capped.plan.milestone_cap).toBe(6);
  });
});
