/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- test doubles */
import { z } from 'zod';
import { AdaptiveRuntimeKernel, type KernelConfig } from '../../../src/runtime/kernel/kernel.js';
import type { Tool } from '../../../src/tools/types.js';

export function fakeTool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    schema: z.object({}),
    readOnly: true,
    run: () => Promise.resolve({ content: '' }),
    ...extra,
  } as unknown as Tool;
}

export function offlineKernel(overrides: Partial<KernelConfig> = {}): AdaptiveRuntimeKernel {
  return new AdaptiveRuntimeKernel({
    enabled: true,
    ollamaUrl: 'http://127.0.0.1:9',
    ollamaModel: 'none',
    embedModel: 'none',
    attentionCeiling: 0.65,
    worktree: process.cwd(),
    maxWindow: 100_000,
    maxMounted: 6,
    reselectEvery: 2,
    registry: false,
    localDiscovery: false,
    publicSkills: false,
    ...overrides,
  });
}
