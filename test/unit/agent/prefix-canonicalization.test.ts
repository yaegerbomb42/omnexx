import { describe, it, expect } from 'vitest';
import {
  canonicalizePrefixText,
  sortJsonKeys,
  canonicalizeTools,
  buildCycleContext,
  type CycleInputs,
} from '../../../src/agent/context.js';
import type { ToolSpec } from '../../../src/providers/types.js';
import type { Plan, PlanNode } from '../../../src/core/plan.js';

const mockTask: PlanNode = {
  id: 'M1.T01',
  type: 'task',
  parentId: 'M1',
  title: 'Task 1',
  why: 'test',
  acceptance: ['test passed'],
  checks: ['npm test'],
  dependsOn: [],
  size: 'S',
  kind: 'tests',
  steps: [],
  allow: [],
  status: 'doing',
  attempts: 0,
  consecutiveRejections: 0,
  approachesTried: [],
  failureSignatures: [],
  rung: 0,
  escalated: false,
  rungStartedAt: 0,
  splitInto: [],
  evidence: [],
};

const mockPlan: Plan = {
  version: 1,
  goal: 'g',
  nodes: [mockTask],
};

describe('Prefix Canonicalization & Deterministic SHA-256 Gate', () => {
  it('canonicalizes Unicode with NFC normalization and standardizes CRLF to LF', () => {
    const decomposed = 'caf\u0065\u0301\r\ntest\r\n';
    const precomposed = 'caf\u00E9\ntest\n';

    const normalized = canonicalizePrefixText(decomposed);
    expect(normalized).toBe(precomposed);
  });

  it('replaces local repository path with $REPO token in prefix texts', () => {
    const raw =
      'The repo is at /Users/developer/workspace/project and files are in /Users/developer/workspace/project/src';
    const canonical = canonicalizePrefixText(raw, '/Users/developer/workspace/project');
    expect(canonical).toBe('The repo is at $REPO and files are in $REPO/src');
  });

  it('sorts JSON schema keys recursively to prevent key jitter', () => {
    interface NestedSchema {
      z: number;
      a: {
        d: number;
        b: number;
        c: { y: number; x: number }[];
      };
    }
    const unordered: NestedSchema = {
      z: 1,
      a: {
        d: 4,
        b: 2,
        c: [{ y: 2, x: 1 }],
      },
    };

    const sorted = sortJsonKeys(unordered) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(['a', 'z']);
    const aObj = sorted.a as Record<string, unknown>;
    expect(Object.keys(aObj)).toEqual(['b', 'c', 'd']);
    const cArr = aObj.c as Record<string, unknown>[];
    const c0 = cArr[0];
    expect(c0).toBeDefined();
    if (c0) {
      expect(Object.keys(c0)).toEqual(['x', 'y']);
    }
    expect(JSON.stringify(sorted)).toBe('{"a":{"b":2,"c":[{"x":1,"y":2}],"d":4},"z":1}');
  });

  it('canonicalizes tools by sorting names and input schemas', () => {
    const tools: ToolSpec[] = [
      {
        name: 'write_file',
        description: 'Write file content\r\n',
        inputSchema: { path: { type: 'string' }, content: { type: 'string' } },
      },
      {
        name: 'bash',
        description: 'Execute command',
        inputSchema: { command: { type: 'string' } },
      },
    ];

    const canonical = canonicalizeTools(tools);
    expect(canonical.map((t) => t.name)).toEqual(['bash', 'write_file']);
    const secondTool = canonical[1];
    expect(secondTool).toBeDefined();
    expect(secondTool?.description).toBe('Write file content\n');
  });

  it('computes identical prefixHash for byte-stable cycles and varies when prefix mutates', () => {
    const baseInputs: CycleInputs = {
      systemPrompt: 'Core agent prompt',
      codemap: 'repo map structure',
      goal: 'Achieve milestone 4.2',
      notes: 'Some lessons learned',
      plan: mockPlan,
      task: mockTask,
      progressTail: 'Initial step',
      evidence: [],
      tools: [
        { name: 'b_tool', description: 'desc', inputSchema: {} },
        { name: 'a_tool', description: 'desc', inputSchema: {} },
      ],
    };

    const cycle1 = buildCycleContext(baseInputs);
    const cycle2 = buildCycleContext({
      ...baseInputs,
      tools: [
        { name: 'a_tool', description: 'desc', inputSchema: {} },
        { name: 'b_tool', description: 'desc', inputSchema: {} },
      ],
    });

    expect(cycle1.prefixHash).toBeDefined();
    expect(cycle1.prefixHash).toHaveLength(64);
    expect(cycle1.prefixHash).toBe(cycle2.prefixHash);

    const mutated = buildCycleContext({
      ...baseInputs,
      systemPrompt: 'Mutated agent prompt',
    });
    expect(mutated.prefixHash).not.toBe(cycle1.prefixHash);
  });
});
