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

describe('CLI notes vs errors in the chat view', () => {
  it('keeps notes neutral and real failures red', async () => {
    const { looksLikeError } = await import('../../../src/tui/session.js');
    for (const note of [
      'not a git repository: started one (git init, a .gitignore, a first commit) so every change can be undone',
      'no tests configured: each change is checked by its task checks and a reviewer (add tests with `omnexx init` for stronger checks)',
      'supervisor pid 85689; `omnexx status r_1`, `omnexx logs -f r_1`',
      'empty folder: started a writing project (git init, omnexx.toml)',
    ])
      expect(looksLikeError(note)).toBe(false);
    for (const err of [
      'error[usage]: missing goal',
      'setup command failed: npm install (exit 1)',
      'cannot read package.json',
    ])
      expect(looksLikeError(err)).toBe(true);
  });
});
