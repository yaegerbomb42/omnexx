import { describe, expect, it } from 'vitest';
import { readTime, timeLabel } from '../../../src/tui/auto-setup.js';

describe('autonomous setup', () => {
  it.each([
    ['90m', '90m'],
    ['3h', '3h'],
    ['1d', '1d'],
    ['1h30m', '1h30m'],
    ['2', '2h'],
    [' 4 H ', '4h'],
  ])('reads %j as %j', (text, value) => {
    expect(readTime(text)).toBe(value);
  });

  it.each(['soon', '10s', '', 'make it faster'])('rejects %j', (text) => {
    expect(readTime(text)).toBeUndefined();
  });

  it('labels times for the prompt', () => {
    expect(timeLabel('8h')).toBe('8 hours');
    expect(timeLabel('30m')).toBe('30 minutes');
    expect(timeLabel('90m')).toBe('90 minutes');
    expect(timeLabel('1d')).toBe('1 day');
  });
});
