import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];
let requestCounts: number[] = [];

// No real agent-browser: record the CLI arguments and answer like its --json output.
vi.mock('execa', () => ({
  execa: (_bin: string, args: string[]) => {
    calls.push(args);
    let data: unknown = {};
    if (args.includes('eval')) data = { result: 'complete' };
    if (args.includes('requests')) {
      const n = requestCounts.length > 1 ? requestCounts.shift() : requestCounts[0];
      data = { requests: Array.from({ length: n ?? 0 }, () => ({ url: 'x' })) };
    }
    if (args.includes('text')) data = { text: 'Save changes' };
    return Promise.resolve({
      stdout: JSON.stringify({ success: true, data, error: null }),
      exitCode: 0,
    });
  },
}));

const { AgentBrowserBackend } = await import('../../../src/tools/extra/browser/agent-browser.js');

/** The command part, after --session <name> --json. */
const cmd = (args: string[] | undefined): string[] => (args ?? []).slice(3);

describe('agent-browser semantic targets', () => {
  beforeEach(() => {
    calls.length = 0;
    requestCounts = [0];
  });

  it('turns text=/label=/role= targets into find commands', async () => {
    const b = new AgentBrowserBackend('s1');
    await b.click('text=Save changes');
    await b.fill('label=Email', 'a@b.c');
    await b.click('role=button[name="Save"]');
    await b.hover('placeholder=Search');
    expect(await b.getText('role=heading')).toBe('Save changes');
    await b.click('#plain');
    expect(calls.map(cmd)).toEqual([
      ['find', 'text', 'Save changes', 'click'],
      ['find', 'label', 'Email', 'fill', 'a@b.c'],
      ['find', 'role', 'button', 'click', '--name', 'Save'],
      ['find', 'placeholder', 'Search', 'hover'],
      ['find', 'role', 'heading', 'text'],
      ['click', '#plain'],
    ]);
  });

  it('waits for the network to go quiet after the document loads', async () => {
    requestCounts = [1, 3, 3, 3, 3, 3, 3];
    const b = new AgentBrowserBackend('s2');
    const started = Date.now();
    await b.waitForLoad(5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(calls.filter((c) => c.includes('requests')).length).toBeGreaterThanOrEqual(3);
  });

  it('sets the viewport', async () => {
    await new AgentBrowserBackend('s3').setViewport(375, 900);
    expect(cmd(calls[0])).toEqual(['set', 'viewport', '375', '900']);
  });
});
