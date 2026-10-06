import { describe, expect, it } from 'vitest';
import { intentAssumptions, renderIntent } from '../../../src/agent/intent.js';
import { progressBar } from '../../../src/tui/app.js';

describe('status and report helpers', () => {
  it('draws a progress bar', () => {
    expect(progressBar(0, 0)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(progressBar(14, 29)).toBe('▰▰▰▰▰▱▱▱▱▱');
    expect(progressBar(29, 29, 4)).toBe('▰▰▰▰');
  });

  it('reads the assumptions back out of intent.md, and nothing else', () => {
    const text = renderIntent({
      product: 'A landing page about monkeys',
      users: '',
      done: ['page loads'],
      assumptions: ['static HTML, no framework', 'dark theme'],
      checks: ['node --test'],
    });
    expect(intentAssumptions(text)).toEqual(['static HTML, no framework', 'dark theme']);
    expect(intentAssumptions('# Inferred intent\n\nx')).toEqual([]);
  });
});
