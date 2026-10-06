import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkForUpdate, isNewer } from '../../../src/cli/update-check.js';
import { tempDir } from '../../support/tmp.js';

describe('update check', () => {
  it('compares versions', () => {
    expect(isNewer('0.3.0', '0.2.9')).toBe(true);
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('1.0.0-rc.1', '0.9.0')).toBe(false);
  });

  it('asks npm at most once a day, and never throws', async () => {
    const cacheFile = join(await tempDir(), 'update.json');
    let calls = 0;
    const fetchFn: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response(JSON.stringify({ version: '9.0.0' })));
    };
    const base = { current: '0.2.0', cacheFile, env: {}, fetch: fetchFn };
    expect(await checkForUpdate({ ...base, now: 0 })).toBe('9.0.0');
    expect(await checkForUpdate({ ...base, now: 3_600_000 })).toBe('9.0.0');
    expect(calls).toBe(1);
    await checkForUpdate({ ...base, now: 25 * 3_600_000 });
    expect(calls).toBe(2);
    const offline: typeof fetch = () => Promise.reject(new Error('offline'));
    expect(
      await checkForUpdate({ ...base, cacheFile: join(await tempDir(), 'u.json'), fetch: offline }),
    ).toBeUndefined();
    expect(await checkForUpdate({ ...base, env: { CI: '1' } })).toBeUndefined();
  });
});
