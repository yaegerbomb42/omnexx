import { describe, expect, it } from 'vitest';
import { writeReport } from '../../src/core/report.js';
import { say, ScriptedProvider } from '../support/scripted-provider.js';
import { startTestRun } from '../support/harness.js';

describe('integrations suggested in an unattended run', () => {
  it('show up under "Needs your decision" with the command to accept them, once each', async () => {
    const t = await startTestRun({ provider: new ScriptedProvider(() => say('unused')) });
    const mcp = {
      kind: 'mcp',
      server: 'io.github.microsoft/playwright-mcp',
      trusted: true,
      runs: 'npx -y @playwright/mcp@0.0.82',
    };
    t.run.events.emit('integration.suggested', mcp);
    t.run.events.emit('integration.suggested', mcp);
    t.run.events.emit('integration.suggested', {
      kind: 'mcp',
      server: 'io.github.someone/x',
      trusted: false,
    });
    t.run.events.emit('integration.suggested', {
      kind: 'skill',
      source: 'https://example.com/skills.git',
    });
    const report = await writeReport(t.run.store, t.run.state, t.run.plan, t.clock.now());
    const section = report.slice(report.indexOf('## 7. Needs your decision'));
    expect(section).toContain(
      '`omnexx mcp add playwright-mcp --pick io.github.microsoft/playwright-mcp`',
    );
    expect(section.match(/playwright-mcp --pick/g)).toHaveLength(1);
    expect(section).toContain('io.github.someone/x (not a known publisher: check it first)');
    expect(section).toContain('`omnexx skills add https://example.com/skills.git`');
  });
});
