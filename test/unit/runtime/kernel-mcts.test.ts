import { describe, expect, it } from 'vitest';
import { runMcts, scoreBranch } from '../../../src/runtime/kernel/mcts.js';
import type { CapabilityEntry, TurnAllocation } from '../../../src/runtime/kernel/types.js';

const tools: CapabilityEntry[] = [
  { kind: 'tool', id: 'read', name: 'read', description: 'read files', tokens: ['read', 'file'] },
  {
    kind: 'tool',
    id: 'search',
    name: 'search',
    description: 'search code',
    tokens: ['search', 'code'],
  },
  {
    kind: 'tool',
    id: 'bash',
    name: 'bash',
    description: 'run tests and shell',
    tokens: ['bash', 'test', 'shell'],
  },
  {
    kind: 'tool',
    id: 'str_replace',
    name: 'str_replace',
    description: 'edit files',
    tokens: ['edit', 'replace'],
  },
  {
    kind: 'tool',
    id: 'write_file',
    name: 'write_file',
    description: 'write files',
    tokens: ['write', 'file'],
  },
];

const seed: TurnAllocation = {
  tier: 2,
  reasoningMode: 'mcts',
  mctsBranchFactor: 4,
  activeRoles: ['executor'],
  mountedTools: ['read'],
  mountedSkills: [],
  maxTokensTurn: 2048,
  allowCodeModeBatching: true,
  blastRadius: 'low',
};

describe('runMcts', () => {
  it('expands branches and selects a scored winner', () => {
    const result = runMcts({
      seed,
      objective: 'fix the failing unit tests',
      telemetry: {
        frictionScore: 3.5,
        contextPressure: 0.3,
        epistemicUncertainty: 0.6,
        consecutiveFailures: 2,
        lastToolSignature: 'bash:npm test',
        turn: 4,
      },
      candidates: tools,
      options: { branchFactor: 4, iterations: 16 },
    });
    expect(result.branches.length).toBeGreaterThanOrEqual(2);
    expect(result.selectedId).toMatch(/^b\d+$/);
    expect(result.best.mountedTools.length).toBeGreaterThan(0);
    // High-friction test-fix should prefer bash + verifier-ish roles.
    expect(
      result.best.mountedTools.includes('bash') || result.best.activeRoles.includes('verifier'),
    ).toBe(true);
  });

  it('scores edit objectives toward edit tools', () => {
    const editHeavy: TurnAllocation = {
      ...seed,
      mountedTools: ['str_replace', 'write_file', 'read'],
      activeRoles: ['executor', 'verifier'],
      reasoningMode: 'reflexion',
    };
    const readOnly: TurnAllocation = {
      ...seed,
      mountedTools: ['read', 'search'],
      activeRoles: ['executor'],
      reasoningMode: 'zero-shot',
    };
    const tel = {
      frictionScore: 1,
      contextPressure: 0.2,
      epistemicUncertainty: 0.2,
      consecutiveFailures: 0,
      lastToolSignature: '',
      turn: 1,
    };
    expect(
      scoreBranch(editHeavy, 'implement the feature and edit src/a.ts', tel, tools),
    ).toBeGreaterThan(scoreBranch(readOnly, 'implement the feature and edit src/a.ts', tel, tools));
  });
});
