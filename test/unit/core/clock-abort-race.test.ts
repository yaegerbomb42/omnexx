import { describe, expect, it } from 'vitest';

import { realClock } from '../../../src/core/clock.js';

describe('realClock.sleep abort race', () => {
  it('rejects with AbortError when signal aborts immediately', async () => {
    for (let i = 0; i < 100; i += 1) {
      const controller = new AbortController();
      const promise = realClock.sleep(1000, controller.signal);
      controller.abort();
      const started = Date.now();
      await expect(promise).rejects.toThrow('aborted');
      expect(Date.now() - started).toBeLessThan(50);
    }
  });
});
