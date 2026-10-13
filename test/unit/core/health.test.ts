import { describe, expect, it } from 'vitest';
import { QUIET_AFTER_MS, runHealth } from '../../../src/core/health.js';

const now = 1_000_000_000;
const base = { status: 'running', supervisorAlive: true, heartbeatStale: false, now };

describe('runHealth', () => {
  it('reads ended, dead and stalled runs from status, supervisor and heartbeat', () => {
    expect(runHealth({ ...base, status: 'finished' })).toBe('ended');
    expect(runHealth({ ...base, supervisorAlive: false })).toBe('dead');
    expect(runHealth({ ...base, heartbeatStale: true })).toBe('stalled');
  });

  it('tells waiting on providers, quiet and working apart by the newest event', () => {
    expect(runHealth({ ...base, lastEvent: { type: 'provider.retry', ts: now } })).toBe('waiting');
    expect(runHealth({ ...base, lastEvent: { type: 'turn', ts: now - QUIET_AFTER_MS } })).toBe(
      'quiet',
    );
    expect(runHealth({ ...base, lastEvent: { type: 'turn', ts: now - 1_000 } })).toBe('working');
    expect(runHealth({ ...base, status: 'paused', lastEvent: { type: 'turn', ts: 0 } })).toBe(
      'working',
    );
  });
});
