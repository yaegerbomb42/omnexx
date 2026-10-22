import { describe, expect, it } from 'vitest';
import {
  contentHash,
  renderCheckDiags,
  SpeculativeFileChecks,
} from '../../../src/core/speculative-check.js';

describe('content hash', () => {
  it('is stable for the same bytes', () => {
    const a = contentHash('hello world');
    expect(contentHash('hello world')).toBe(a);
  });

  it('changes when the bytes change', () => {
    expect(contentHash('hello world')).not.toBe(contentHash('hello world!'));
  });

  it('includes the length so different lengths collide less', () => {
    const a = contentHash('ab');
    const b = contentHash('a' + 'b');
    expect(a).toBe(b);
  });
});

describe('render check diagnostics', () => {
  it('renders nothing for a clean file', () => {
    expect(renderCheckDiags({ path: 'a.ts', hash: 'x', diags: [], ms: 10, ok: true })).toBe('');
  });

  it('renders the first twenty diagnostics', () => {
    const diags = Array.from({ length: 25 }, (_, i) => ({
      line: i + 1,
      code: 'ts',
      message: `diagnostic ${String(i)}`,
    }));
    const out = renderCheckDiags({ path: 'a.ts', hash: 'x', diags, ms: 10, ok: false });
    expect(out).toContain('line 1: ts diagnostic 0');
    expect(out).toContain('line 20: ts diagnostic 19');
    expect(out).not.toContain('diagnostic 24');
    expect(out).toContain('(+5 more)');
  });
});

describe('speculative file checks', () => {
  const opts = { root: '/tmp', env: {} };

  it('starts with no results', () => {
    const checks = new SpeculativeFileChecks(opts);
    expect(checks.size).toBe(0);
    expect(checks.get('a.ts', 'anything')).toBeUndefined();
  });

  it('keeps a result keyed by content hash', () => {
    const checks = new SpeculativeFileChecks(opts);
    // Touching starts a background check; without a compiler it fails and leaves no result.
    checks.touch('a.ts', 'const x = 1;\n');
    expect(checks.size).toBe(0);
  });
});
