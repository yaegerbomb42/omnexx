import { describe, expect, it } from 'vitest';
import { AGENT_META } from '../../src/cli/chat-agent-settings.js';
import {
  meaning,
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
});
