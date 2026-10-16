import { describe, expect, it } from 'vitest';
import { derivedAgentLayer, workerWindow } from '../../../src/config/agent-settings.js';
import { fmtK } from '../../../src/core/agent-levels.js';
import { knownWindow } from '../../../src/providers/context-windows.js';

describe('known context windows', () => {
  it('knows the 1M families and the 200k exceptions', () => {
    expect(knownWindow('anthropic:claude-opus-5-5')).toBe(1_000_000);
    expect(knownWindow('anthropic:claude-sonnet-5-5')).toBe(1_000_000);
    expect(knownWindow('anthropic:claude-fable-5-1')).toBe(1_000_000);
    expect(knownWindow('anthropic:claude-haiku-4-5-20251001')).toBe(200_000);
    expect(knownWindow('gemini:gemini-2.5-pro')).toBe(1_048_576);
    expect(knownWindow('gemini:gemini-2.0-flash')).toBe(1_048_576);
    expect(knownWindow('openai:gpt-4.1-mini')).toBe(1_047_576);
    expect(knownWindow('ollama:qwen2.5-coder:7b')).toBeUndefined();
  });

  it("a profile's own context wins over the family's", () => {
    const merged = {
      models: {
        worker: 'anthropic:claude-opus-5-5',
        profiles: { 'anthropic:claude-opus-5-5': { context: 200_000 } },
      },
    };
    expect(workerWindow(merged)).toBe(200_000);
    expect(workerWindow({ models: { worker: ['anthropic:claude-opus-5-5'] } })).toBe(1_000_000);
  });

  it('the 1M level on a 1M model is clamped to 85% of the window', () => {
    const layer = derivedAgentLayer({
      agent: { context_level: 10 },
      models: { worker: 'gemini:gemini-2.5-pro' },
    });
    expect(layer).toMatchObject({ context: { budget_tokens: 891_289, compact_at: 757_595 } });
    const small = derivedAgentLayer({
      agent: { context_level: 10 },
      models: { worker: 'anthropic:claude-haiku-4-5-20251001' },
    });
    expect(small).toMatchObject({ context: { budget_tokens: 170_000 } });
  });

  it('formats a million as 1M', () => {
    expect(fmtK(1_000_000)).toBe('1M');
    expect(fmtK(500_000)).toBe('500k');
  });
});
