import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig } from '../../../src/config/load.js';
import { readOnlyTools, WORKER_TOOLS, workerTools } from '../../../src/tools/registry.js';
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

  it('the default barrel contributes the integrations and skill tools after the core tools', async () => {
    expect((await workerTools(config)).map((t) => t.name)).toEqual([
      ...WORKER_TOOLS.map((t) => t.name),
      'integrations_install',
      'integrations_search',
      'skill',
    ]);
  });
});
