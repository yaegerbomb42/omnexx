import { describe, expect, it } from 'vitest';
import { isUrlAllowed } from '../../../src/tools/extra/browser/security.js';
import { trimSnapshot } from '../../../src/tools/extra/browser/snapshot.js';
import {
  browserDoctorCheck,
  detectBrowserBackend,
} from '../../../src/tools/extra/browser/detector.js';

describe('browser security', () => {
  const allow = ['localhost', '127.0.0.1', '*.local'];

  it('allows matching localhost and 127.0.0.1', () => {
    expect(isUrlAllowed('http://localhost:3000', allow)).toBe(true);
    expect(isUrlAllowed('http://localhost:8080/path?query=1', allow)).toBe(true);
    expect(isUrlAllowed('http://127.0.0.1:5173', allow)).toBe(true);
  });

  it('allows wildcard local hosts', () => {
    expect(isUrlAllowed('http://app.local:3000', allow)).toBe(true);
    expect(isUrlAllowed('http://my-sub.app.local', allow)).toBe(true);
  });

  it('refuses external domains and invalid schemes', () => {
    expect(isUrlAllowed('https://google.com', allow)).toBe(false);
    expect(isUrlAllowed('https://evil.com/localhost', allow)).toBe(false);
    expect(isUrlAllowed('file:///etc/passwd', allow)).toBe(false);
    expect(isUrlAllowed('javascript:alert(1)', allow)).toBe(false);
  });
});

describe('snapshot trimming', () => {
  it('returns small snapshots unmodified', () => {
    const small = '- button "Submit" [ref=e1]\n- input [ref=e2]';
    expect(trimSnapshot(small, 4000)).toBe(small);
  });

  it('trims large snapshots and adds footer', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `- item-${i} [ref=e${i}]`);
    const big = lines.join('\n');
    const trimmed = trimSnapshot(big, 50); // Small token cap
    expect(trimmed).toContain('…');
    expect(trimmed).toMatch(/more nodes/);
  });
});

describe('browser doctor check', () => {
  it('returns status ok or warn with details', async () => {
    const res = await browserDoctorCheck();
    expect(res.name).toBe('browser backend');
    expect(['ok', 'warn']).toContain(res.status);
    expect(typeof res.detail).toBe('string');
  });

  it('detects available backend', async () => {
    const backend = await detectBrowserBackend();
    expect(backend).toBeDefined();
    expect(['agent-browser', 'playwright', null]).toContain(backend.backend);
  });
});
