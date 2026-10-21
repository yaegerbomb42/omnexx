import { describe, it, expect } from 'vitest';
import { replProjectionTool } from '../../../src/tools/repl-projection.js';
import { toolContext } from '../../support/tool-context.js';

describe('replProjectionTool', () => {
  it('evaluates pure transformations and filtering logic', async () => {
    const ctx = await toolContext(process.cwd());

    const result = await replProjectionTool.run(
      {
        code: `
          return input.items
            .filter(x => x.active)
            .map(x => ({ id: x.id, score: x.val * 2 }));
        `,
        input: {
          items: [
            { id: 'a', val: 10, active: true },
            { id: 'b', val: 20, active: false },
            { id: 'c', val: 30, active: true },
          ],
        },
        timeoutMs: 1000,
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as { id: string; score: number }[];
    expect(parsed).toEqual([
      { id: 'a', score: 20 },
      { id: 'c', score: 60 },
    ]);
  });

  it('safely catches syntax or runtime errors within the sandbox', async () => {
    const ctx = await toolContext(process.cwd());

    const result = await replProjectionTool.run(
      {
        code: 'throw new Error("Projection computation aborted");',
        timeoutMs: 1000,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Projection computation aborted');
  });
});
