import { describe, expect, it } from 'vitest';
import { narrateTool, thinkingGist } from '../../../src/telemetry/narrate.js';

describe('thinking lines', () => {
  it('shows the decision, not the restated request', () => {
    expect(
      thinkingGist(
        'The user says: "work on desktop/infra apps myainow look to improve anything". Likely they want me to improve code in desktop/infra apps. Need to explore repository for a directory desktop/infra apps.',
      ),
    ).toBe('Need to explore repository for a directory desktop/infra apps.');
    expect(
      thinkingGist(
        'User said: "work on desktop/infra apps myainow look to improve anything". Likely want improvements. Need to identify any issues, maybe lint, scripts, etc. Let\'s inspect the omnexx app. List its files.',
      ),
    ).toBe("Let's inspect the omnexx app. List its files.");
  });

  it('skips a thought that repeats the last one, and keeps short ones whole', () => {
    expect(thinkingGist('Let me run the tests.', 'Let me run the tests.')).toBe('');
    expect(thinkingGist('Checking the config.')).toBe('Checking the config.');
  });

  it('clips long thoughts from the end', () => {
    const g = thinkingGist(`Plan: ${'step and step. '.repeat(40)}Then write the file.`, '', 80);
    expect(g.length).toBeLessThanOrEqual(80);
    expect(g.endsWith('Then write the file.')).toBe(true);
  });

  it('names what the list tool and an empty search do', () => {
    expect(narrateTool('list', { path: 'infra/apps' })).toBe('listing infra/apps');
    expect(narrateTool('list', {})).toBe('listing the project');
    expect(narrateTool('search', { pattern: '' })).toBe('listing the files');
  });
});
