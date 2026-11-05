import { describe, expect, it } from 'vitest';
import { TelemetryMonitor, classifyToolError } from '../../../src/runtime/kernel/telemetry.js';

const profile = { maxWindow: 100_000, attentionCeiling: 0.65, maxMountedTools: 8 };

describe('TelemetryMonitor', () => {
  it('tracks friction on errors and resets on validated progress', () => {
    const m = new TelemetryMonitor(profile);
    m.observeTool({ tool: 'bash', inputSummary: 'npm test', isError: true, kind: 'exit' });
    expect(m.snapshot().frictionScore).toBeGreaterThan(0);
    expect(m.snapshot().consecutiveFailures).toBe(1);

    m.observeTool({
      tool: 'bash',
      inputSummary: 'npm test',
      isError: true,
      kind: 'repeat',
    });
    const mid = m.snapshot().frictionScore;
    expect(mid).toBeGreaterThan(2);

    m.observeTool({
      tool: 'str_replace',
      inputSummary: 'src/a.ts',
      isError: false,
      stateProgress: 1,
    });
    expect(m.snapshot().frictionScore).toBe(0);
    expect(m.snapshot().consecutiveFailures).toBe(0);
  });

  it('computes context pressure against the attention ceiling', () => {
    const m = new TelemetryMonitor(profile);
    // ceiling = 100_000 * 0.65 = 65_000
    m.setPromptTokens(32_500);
    expect(m.snapshot().contextPressure).toBeCloseTo(0.5, 5);
    m.setPromptTokens(65_000);
    expect(m.snapshot().contextPressure).toBeCloseTo(1, 5);
    expect(m.needsCompaction(0.9)).toBe(true);
  });

  it('parses logprob entropy into epistemic uncertainty', () => {
    const m = new TelemetryMonitor(profile);
    m.observeLogprobs([{ logprob: Math.log(0.5) }, { logprob: Math.log(0.5) }]);
    const u = m.snapshot().epistemicUncertainty;
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThanOrEqual(1);
  });

  it('derives uncertainty from rollout divergence', () => {
    const m = new TelemetryMonitor(profile);
    m.observeDivergence([1, 1, 1]);
    expect(m.snapshot().epistemicUncertainty).toBeCloseTo(0, 5);
    m.observeDivergence([0, 0, 0]);
    expect(m.snapshot().epistemicUncertainty).toBeCloseTo(1, 5);
  });

  it('shouldRollback after sustained friction', () => {
    const m = new TelemetryMonitor(profile);
    expect(m.shouldRollback()).toBe(false);
    for (let i = 0; i < 4; i++) {
      m.observeTool({ tool: 'bash', inputSummary: `x${i}`, isError: true, kind: 'exit' });
    }
    expect(m.shouldRollback()).toBe(true);
  });
});

describe('classifyToolError', () => {
  it('classifies common failure families', () => {
    expect(classifyToolError('SyntaxError: Unexpected token')).toBe('syntax');
    expect(classifyToolError('eslint found 3 errors')).toBe('lint');
    expect(classifyToolError('error TS2304: Cannot find name')).toBe('compiler');
    expect(classifyToolError('Command failed with exit code 1')).toBe('exit');
    expect(classifyToolError('something else')).toBe('other');
  });
});
