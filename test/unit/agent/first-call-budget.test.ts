import { describe, expect, it } from 'vitest';
import { buildCycleContext } from '../../../src/agent/context.js';
import { WORKER_SYSTEM } from '../../../src/agent/prompts.js';
import { defaultConfig } from '../../../src/config/load.js';
import { contextBreakdown } from '../../../src/core/cycle.js';
import { fastPlan, FAST_TASK } from '../../../src/core/fast-path.js';
import { renderNotes } from '../../../src/core/notes.js';
import { getNode } from '../../../src/core/plan.js';
import { exposedTools, toolSpec, workerTools } from '../../../src/tools/registry.js';
import { isolatedEnv, tempRepo } from '../../support/tmp.js';

/** The first call of a fresh run on a small repo, as stepAct builds it. */
async function freshFirstCall() {
  // The machine's own ~/.claude skills and agents must not change what is measured.
  const config = defaultConfig({
    skills: { import_claude: false },
    agents: { import_claude: false },
  });
  const repo = await tempRepo();
  const where = { repoRoot: repo, env: await isolatedEnv() };
  const tools = exposedTools(await workerTools(config, where), {
    subagents: config.context.subagents,
    hasHistory: false,
    autoApprove: config.policy.auto_approve,
  });
  const goal = 'Add a --version flag to the CLI and test it.';
  const plan = fastPlan(config, goal);
  return buildCycleContext({
    systemPrompt: WORKER_SYSTEM,
    codemap: '# Codebase map\n\nsrc/cli.ts\n  main() L1\ntest/cli.test.ts\n',
    goal,
    notes: renderNotes([]),
    plan,
    task: getNode(plan, FAST_TASK),
    progressTail: '',
    evidence: [],
    sections: config.context.sections,
    tools: tools.map(toolSpec),
  });
}

describe('first-call budget (master todo #8)', () => {
  it('a fresh fast-path first call fits in 3.9k estimated tokens', async () => {
    const split = contextBreakdown(await freshFirstCall());
    const total = Object.values(split).reduce((a, b) => a + b, 0);
    expect(total, JSON.stringify(split)).toBeLessThanOrEqual(3_950);
  });
});
