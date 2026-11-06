import { describe, expect, it } from 'vitest';
import { TelemetryMonitor, toolStateProgress } from '../../../src/runtime/kernel/telemetry.js';

describe('bug #7: progress heuristic', () => {
  it('only successful mutating, non-shell tools count as progress', () => {
    expect(toolStateProgress({ name: 'write_file', readOnly: false, isError: false })).toBe(1);
    expect(toolStateProgress({ name: 'write_file', readOnly: false, isError: true })).toBe(0);
    expect(toolStateProgress({ name: 'bash', readOnly: false, isError: false })).toBe(0);
    expect(toolStateProgress({ name: 'list', readOnly: true, isError: false })).toBe(0);
    expect(toolStateProgress({ name: 'outline', readOnly: undefined, isError: false })).toBe(0);
  });

  it('mixed failures and successful shell calls still reach rollback', () => {
    const t = new TelemetryMonitor({
      maxWindow: 100_000,
      attentionCeiling: 0.65,
      maxMountedTools: 8,
    });
    for (let i = 0; i < 4; i++) {
      t.observeTool({ tool: 'bash', inputSummary: `fail${i}`, isError: true, kind: 'exit' });
      const p = toolStateProgress({ name: 'bash', readOnly: false, isError: false });
      t.observeTool({
        tool: 'bash',
        inputSummary: `ok${i}`,
        isError: false,
        ...(p ? { stateProgress: p } : {}),
      });
    }
    expect(t.shouldRollback()).toBe(true);
  });
});
