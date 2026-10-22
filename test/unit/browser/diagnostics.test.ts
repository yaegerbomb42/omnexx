import { describe, expect, it } from 'vitest';
import {
  collectBrowserDiagnostics,
  diagnosticsNote,
  formatBrowserDiagnostics,
  hasDiagnostics,
  isFailedRequest,
  isProblemConsole,
  type ConsoleEntry,
  type NetworkEntry,
} from '../../../src/browser/diagnostics.js';

const entry = (type: string, text: string, location?: string): ConsoleEntry => ({
  type,
  text,
  ...(location ? { location } : {}),
});

describe('browser diagnostics', () => {
  it('reports a clean page', () => {
    const d = collectBrowserDiagnostics({
      console: [entry('log', 'hello')],
      requests: [{ method: 'GET', url: 'http://x/', status: 200 }],
    });
    expect(d).toMatchObject({
      errors: 0,
      warnings: 0,
      failedRequests: 0,
      console: [],
      requests: [],
    });
    expect(d.summary).toBe('no frontend errors');
    expect(hasDiagnostics(d)).toBe(false);
  });

  it('prioritizes exceptions, then console errors, then warnings', () => {
    const d = collectBrowserDiagnostics({
      console: [
        entry('log', 'noise'),
        entry('warning', 'deprecated', 'app.js:1:1'),
        entry('error', 'fetch failed'),
        entry('pageerror', 'Uncaught TypeError'),
        entry('assert', 'assertion failed'),
      ],
      requests: [],
    });
    expect(d.console.map((m) => m.type)).toEqual(['pageerror', 'error', 'assert', 'warning']);
    expect(d.errors).toBe(3);
    expect(d.warnings).toBe(1);
    expect(d.summary).toBe('3 console errors, 1 warning');
    expect(d.console[0]).toEqual({
      type: 'pageerror',
      text: 'Uncaught TypeError',
    });
    expect(d.console[3]).toEqual({
      type: 'warning',
      text: 'deprecated',
      location: 'app.js:1:1',
    });
  });

  it('collapses repeated renders of the same error', () => {
    const d = collectBrowserDiagnostics({
      console: [
        entry('error', 'cannot read x'),
        entry('error', 'cannot read x'),
        entry('error', 'cannot read x'),
      ],
      requests: [
        { method: 'GET', url: 'http://x/api', status: 500 },
        { method: 'GET', url: 'http://x/api', status: 500 },
      ],
    });
    expect(d.errors).toBe(3);
    expect(d.console).toHaveLength(1);
    expect(d.failedRequests).toBe(2);
    expect(d.requests).toHaveLength(1);
  });

  it('counts every failure even when the list is capped', () => {
    const d = collectBrowserDiagnostics(
      {
        console: Array.from({ length: 8 }, (_, i) => entry('error', `e${i}`)),
        requests: Array.from({ length: 8 }, (_, i) => ({
          method: 'GET',
          url: `http://x/${i}`,
          status: 404,
        })),
      },
      { limit: 2 },
    );
    expect(d.errors).toBe(8);
    expect(d.failedRequests).toBe(8);
    expect(d.console).toHaveLength(2);
    expect(d.requests).toHaveLength(2);
  });

  it('can leave warnings out', () => {
    const d = collectBrowserDiagnostics(
      { console: [entry('warning', 'w'), entry('error', 'e')], requests: [] },
      { includeWarnings: false },
    );
    expect(d.errors).toBe(1);
    expect(d.warnings).toBe(0);
    expect(d.console.map((m) => m.text)).toEqual(['e']);
  });

  it('treats network-level failures and 4xx/5xx as problems', () => {
    expect(isFailedRequest({ method: 'GET', url: 'x' })).toBe(true);
    expect(isFailedRequest({ method: 'GET', url: 'x', failure: 'ECONNREFUSED' })).toBe(true);
    expect(isFailedRequest({ method: 'GET', url: 'x', status: 404 })).toBe(true);
    expect(isFailedRequest({ method: 'GET', url: 'x', status: 200 })).toBe(false);
    expect(isFailedRequest({ method: 'GET', url: 'x', status: 302 })).toBe(false);

    const requests: NetworkEntry[] = [
      { method: 'POST', url: 'http://x/api', status: 500, resourceType: 'xhr' },
      { method: 'GET', url: 'http://x/missing', status: 404 },
      { method: 'GET', url: 'http://x/offline', failure: 'ECONNREFUSED' },
      { method: 'GET', url: 'http://x/ok', status: 200 },
    ];
    const d = collectBrowserDiagnostics({ console: [], requests });
    expect(d.failedRequests).toBe(3);
    expect(d.summary).toBe('3 failed requests');
    expect(d.requests[0]).toEqual({
      method: 'POST',
      url: 'http://x/api',
      status: 500,
      resourceType: 'xhr',
    });
  });

  it('recognises which console levels are problems', () => {
    expect(isProblemConsole(entry('error', 'x'))).toBe(true);
    expect(isProblemConsole(entry('pageerror', 'x'))).toBe(true);
    expect(isProblemConsole(entry('assert', 'x'))).toBe(true);
    expect(isProblemConsole(entry('warning', 'x'))).toBe(true);
    expect(isProblemConsole(entry('warning', 'x'), false)).toBe(false);
    expect(isProblemConsole(entry('log', 'x'))).toBe(false);
  });

  it('formats a readable report with locations, failures and clipping', () => {
    const long = 'x'.repeat(600);
    const d = collectBrowserDiagnostics({
      console: [entry('pageerror', long, 'main.js:10:2')],
      requests: [
        { method: 'GET', url: 'http://x/a', status: 500, resourceType: 'fetch' },
        { method: 'GET', url: 'http://x/b', failure: 'ECONNREFUSED' },
      ],
    });
    expect(d.console[0]?.text.endsWith('…')).toBe(true);
    expect(d.console[0]?.text).toHaveLength(501);

    const text = formatBrowserDiagnostics(d, { heading: 'After click' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('After click: 1 console error, 2 failed requests');
    expect(lines[1]).toContain('[pageerror]');
    expect(lines[1]).toContain('(main.js:10:2)');
    expect(lines[2]).toBe('  500 GET http://x/a (fetch)');
    expect(lines[3]).toBe('  FAILED ECONNREFUSED GET http://x/b');
  });

  it('caps the formatted report and notes how many lines were hidden', () => {
    const d = collectBrowserDiagnostics({
      console: Array.from({ length: 5 }, (_, i) => entry('error', `e${i}`)),
      requests: [],
    });
    const text = formatBrowserDiagnostics(d, { maxLines: 2 });
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('… 3 more');
  });

  it('produces a short note for post-action output', () => {
    const d = collectBrowserDiagnostics({
      console: [entry('error', 'boom')],
      requests: [],
    });
    expect(diagnosticsNote(d)).toBe(
      'Frontend diagnostics after this action: 1 console error\n  [error] boom',
    );
  });
});
