import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig } from '../../../src/config/load.js';
import {
  exposedTools,
  readOnlyTools,
  WORKER_TOOLS,
  workerTools,
} from '../../../src/tools/registry.js';
import type { Tool } from '../../../src/tools/types.js';

const fake = (name: string, readOnly = false): Tool => ({
  name,
  description: name,
  schema: z.object({}),
  readOnly,
  run: () => Promise.resolve({ content: '' }),
});

describe('extra tool sources', () => {
  // The host's ~/.claude skills and agents must not change the tool list under test.
  const config = defaultConfig({
    skills: { import_claude: false },
    agents: { import_claude: false },
  });

  it('keeps core tools first, then extras sorted by name regardless of source order', async () => {
    const tools = await workerTools(config, undefined, {
      zeta: { load: () => [fake('web_fetch', true)] },
      alpha: { load: () => Promise.resolve([fake('browser')]) },
    });
    expect(tools.map((t) => t.name)).toEqual([
      ...WORKER_TOOLS.map((t) => t.name),
      'browser',
      'web_fetch',
    ]);
    const ro = await readOnlyTools(config, undefined, {
      a: { load: () => [fake('web_fetch', true)] },
    });
    expect(ro.map((t) => t.name)).toContain('web_fetch');
  });

  it('rejects a name that collides with a core or another extra tool', async () => {
    await expect(
      workerTools(config, undefined, { a: { load: () => [fake('bash')] } }),
    ).rejects.toThrow(/duplicate tool name "bash"/);
  });

  it('with no sources registered, matches the core tool list exactly', async () => {
    expect(await workerTools(config, undefined, {})).toEqual(WORKER_TOOLS);
  });

  it('the default barrel adds the integrations tools after the core tools, and no skill tool without skills', async () => {
    expect((await workerTools(config)).map((t) => t.name)).toEqual([
      ...WORKER_TOOLS.map((t) => t.name),
      'integrations_install',
      'integrations_search',
    ]);
  });
});

describe('exposedTools', () => {
  const names = (tools: readonly Tool[]): string[] => tools.map((t) => t.name);

  it('hides task until subagents are on and recall until there is history', () => {
    expect(
      names(exposedTools(WORKER_TOOLS, { subagents: false, hasHistory: false })),
    ).not.toContain('task');
    expect(
      names(exposedTools(WORKER_TOOLS, { subagents: false, hasHistory: false })),
    ).not.toContain('recall');
    expect(names(exposedTools(WORKER_TOOLS, { subagents: true, hasHistory: true }))).toEqual(
      expect.arrayContaining(['task', 'recall']),
    );
  });

  it('keeps read_log: bash can cut a log at any time and points the model at it', () => {
    expect(names(exposedTools(WORKER_TOOLS, { subagents: false, hasHistory: false }))).toContain(
      'read_log',
    );
  });

  it('drops only the gated tools and leaves every other tool in order', () => {
    const kept = exposedTools(WORKER_TOOLS, { subagents: false, hasHistory: false });
    expect(names(kept)).toEqual(
      WORKER_TOOLS.map((t) => t.name).filter((n) => n !== 'task' && n !== 'recall'),
    );
  });
});
