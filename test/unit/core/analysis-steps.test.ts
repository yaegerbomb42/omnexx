import { describe, expect, it } from 'vitest';
import { analysisSteps, stepsTodo, wroteTodo } from '../../../src/core/analysis-steps.js';

describe('analysisSteps', () => {
  it('takes the top-level items under the ordered-steps section, up to the next section', () => {
    const analysis = [
      '1. Framing: the parser drops the last token.',
      '2. Root causes: off-by-one.',
      '3. Approach: fix the loop bound.',
      '4. **Ordered steps:**',
      '   1. Fix the bound in `src/parse.ts`',
      '      - check the empty input too',
      '   2. Add a regression test',
      '   3. Run **npm test**',
      '5. How you will verify each step: npm test',
      '   - not a step',
    ].join('\n');
    expect(analysisSteps(analysis)).toEqual([
      'Fix the bound in src/parse.ts',
      'Add a regression test',
      'Run npm test',
    ]);
  });

  it('reads markdown headings and stops at the next one', () => {
    const analysis = '## Steps\n- a\n- b\n## Verification\n- c';
    expect(analysisSteps(analysis)).toEqual(['a', 'b']);
  });

  it('reads markdown heading-style steps without stopping early', () => {
    const analysis = [
      '## Ordered steps',
      '### Step 1: First action',
      '### Step 2: Second action',
      '### 3. Third action',
      '## Verification',
      '- verify things',
    ].join('\n');
    expect(analysisSteps(analysis)).toEqual(['First action', 'Second action', 'Third action']);
  });

  it('gives nothing without a steps section or with a single step', () => {
    expect(analysisSteps('1. Framing\n- a\n- b')).toEqual([]);
    expect(analysisSteps('Ordered steps:\n- just one\nSpec cases:\n- x')).toEqual([]);
  });

  it('keeps texts within the todo limits', () => {
    const steps = analysisSteps(
      `Steps:\n${Array.from({ length: 20 }, () => `- ${'y'.repeat(300)}`).join('\n')}`,
    );
    expect(steps).toHaveLength(12);
    expect(steps.every((s) => s.length <= 200)).toBe(true);
  });
});

describe('stepsTodo / wroteTodo', () => {
  it('puts the first step under way, or all done', () => {
    expect(stepsTodo(['a', 'b']).map((i) => i.status)).toEqual(['in_progress', 'pending']);
    expect(stepsTodo(['a', 'b'], true).map((i) => i.status)).toEqual(['done', 'done']);
  });

  it('sees a todo call by the model', () => {
    expect(
      wroteTodo([
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'todo', input: {} }] },
      ]),
    ).toBe(true);
    expect(wroteTodo([{ role: 'assistant', content: [{ type: 'text', text: 'todo' }] }])).toBe(
      false,
    );
  });
});
