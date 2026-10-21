import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { maskToolsForPhase } from '../../../src/tools/fsm-mask.js';
import type { Tool } from '../../../src/tools/types.js';

describe('maskToolsForPhase', () => {
  const dummyTool = (name: string, readOnly: boolean): Tool => ({
    name,
    description: name,
    schema: z.object({}),
    readOnly,
    run: () => Promise.resolve({ content: '' }),
  });

  const tools: readonly Tool[] = [
    dummyTool('read', true),
    dummyTool('search', true),
    dummyTool('task', true),
    dummyTool('write_file', false),
    dummyTool('str_replace', false),
    dummyTool('bash', false),
  ];

  it('restricts tools to readOnly during planning and investigate phases', () => {
    const planning = maskToolsForPhase(tools, 'planning');
    expect(planning.every((t) => t.readOnly)).toBe(true);
    expect(planning.map((t) => t.name)).toEqual(['read', 'search', 'task']);

    const investigate = maskToolsForPhase(tools, 'investigate');
    expect(investigate.map((t) => t.name)).toEqual(['read', 'search', 'task']);
  });

  it('restricts task delegation during review phase', () => {
    const review = maskToolsForPhase(tools, 'review');
    expect(review.every((t) => t.readOnly)).toBe(true);
    expect(review.map((t) => t.name)).toEqual(['read', 'search']);
  });

  it('allows all tools during execution phase', () => {
    const execution = maskToolsForPhase(tools, 'execution');
    expect(execution).toHaveLength(tools.length);
  });
});
