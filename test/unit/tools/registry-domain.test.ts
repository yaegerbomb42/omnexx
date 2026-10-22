import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import {
  CODE_ONLY_TOOLS,
  WORKER_TOOLS,
  forDomain,
  readOnlyTools,
  workerTools,
} from '../../../src/tools/registry.js';

const swe = defaultConfig();
const general = defaultConfig({ execution: { domain: 'general' } });

describe('tool filtering by work domain', () => {
  it('classifies exactly the AST/symbol tools as code-only', () => {
    expect([...CODE_ONLY_TOOLS].sort()).toEqual(['outline', 'read_symbol']);
  });

  it('swe keeps the full core toolset, in order', async () => {
    const tools = await workerTools(swe, undefined, {});
    expect(tools).toEqual(WORKER_TOOLS);
    expect(tools.map((t) => t.name)).toContain('read_symbol');
    expect(tools.map((t) => t.name)).toContain('outline');
  });

  it('general suppresses outline and read_symbol but keeps the universal tools', async () => {
    const names = (await workerTools(general, undefined, {})).map((t) => t.name);
    expect(names).not.toContain('outline');
    expect(names).not.toContain('read_symbol');
    for (const universal of [
      'read',
      'search',
      'write_file',
      'str_replace',
      'bash',
      'remember',
      'running_context',
      'todo',
    ])
      expect(names).toContain(universal);
  });

  it('general read-only tools (planner, helpers) lose read_symbol too', async () => {
    const names = (await readOnlyTools(general, undefined, {})).map((t) => t.name);
    expect(names).not.toContain('read_symbol');
    expect(names).not.toContain('outline');
    expect(names).toContain('read');
    expect(names).toContain('search');
  });

  it('forDomain is the identity for swe and a filter for general', () => {
    expect(forDomain(WORKER_TOOLS, swe)).toBe(WORKER_TOOLS);
    const filtered = forDomain(WORKER_TOOLS, general);
    expect(filtered.length).toBe(WORKER_TOOLS.length - CODE_ONLY_TOOLS.size);
  });
});
