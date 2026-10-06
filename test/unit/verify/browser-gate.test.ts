import { describe, expect, it } from 'vitest';
import { parseBrowserGateScript } from '../../../src/verify/browser-gate.js';

describe('browser gate parser', () => {
  it('parses valid YAML gate script', () => {
    const yaml = `steps:
  - action: open
    url: http://localhost:3000
  - action: click
    selector: "@btn"
  - action: expect_text
    text: Hello
`;
    const parsed = parseBrowserGateScript(yaml);
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toEqual({ action: 'open', url: 'http://localhost:3000' });
    expect(parsed.steps[1]).toEqual({ action: 'click', selector: '@btn' });
    expect(parsed.steps[2]).toEqual({ action: 'expect_text', text: 'Hello' });
  });

  it('parses simple yaml scalars', () => {
    const yaml = `
steps:
  - action: wait_ms
    ms: 500
  - action: expect_no_console_errors
`;
    const parsed = parseBrowserGateScript(yaml);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]).toEqual({ action: 'wait_ms', ms: 500 });
    expect(parsed.steps[1]).toEqual({ action: 'expect_no_console_errors' });
  });

  it('rejects invalid actions', () => {
    const invalid = `steps:
  - action: unknown_action
    foo: bar
`;
    expect(() => parseBrowserGateScript(invalid)).toThrow();
  });
});
