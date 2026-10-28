import { describe, expect, it } from 'vitest';
import { AGENT_META } from '../../src/cli/chat-agent-settings.js';
import {
  applyModePreset,
  detectMode,
  meaning,
  MODE_PRESETS,
  position,
  steps,
  withPosition,
  type AgentLevels,
  type AgentMeta,
} from '../../vscode/src/webview/agentCardModel.js';

const meta: AgentMeta = JSON.parse(JSON.stringify(AGENT_META)) as AgentMeta;
const levels: AgentLevels = {
  taskEffort: 3,
  turnEffort: 4,
  contextLevel: 5,
  time: '30m',
  maxTokens: 8_192,
};

describe('VS Code agent card', () => {
  it('shows the meaning of each slider like the terminal does', () => {
    expect(meaning('taskEffort', levels, meta)).toBe('3 · small focused change, light planning');
    expect(meaning('contextLevel', levels, meta)).toBe('64k · standard');
    expect(meaning('time', levels, meta)).toBe('30m');
    expect(meaning('maxTokens', levels, meta)).toBe('8k');
  });

  it('maps slider positions to values and back, without mutating', () => {
    expect(position('time', levels, meta)).toBe(3);
    expect(position('maxTokens', levels, meta)).toBe(4);
    expect(steps('time', meta)).toBe(8);
    expect(steps('taskEffort', meta)).toBe(10);
    const next = withPosition('time', 8, levels, meta);
    expect(next.time).toBe('unlimited');
    expect(levels.time).toBe('30m');
    expect(withPosition('maxTokens', 7, levels, meta).maxTokens).toBe(64_000);
    expect(withPosition('taskEffort', 9, levels, meta).taskEffort).toBe(9);
  });

  it('applies mode presets to update all 5 settings simultaneously', () => {
    expect(MODE_PRESETS.efficient.taskEffort).toBe(3);
    const efficient = applyModePreset('efficient');
    expect(efficient.taskEffort).toBe(3);
    expect(efficient.turnEffort).toBe(3);
    expect(efficient.contextLevel).toBe(4);
    expect(efficient.time).toBe('30m');
    expect(efficient.maxTokens).toBe(4_096);
    expect(detectMode(efficient)).toBe('efficient');

    const normal = applyModePreset('normal');
    expect(normal.taskEffort).toBe(5);
    expect(normal.turnEffort).toBe(5);
    expect(normal.contextLevel).toBe(6);
    expect(normal.time).toBe('2h');
    expect(normal.maxTokens).toBe(16_000);
    expect(detectMode(normal)).toBe('normal');

    const extreme = applyModePreset('extreme');
    expect(extreme.taskEffort).toBe(9);
    expect(extreme.turnEffort).toBe(9);
    expect(extreme.contextLevel).toBe(9);
    expect(extreme.time).toBe('8h');
    expect(extreme.maxTokens).toBe(32_000);
    expect(detectMode(extreme)).toBe('extreme');

    // Custom levels return null for detectMode
    expect(detectMode(levels)).toBeNull();
  });
});
