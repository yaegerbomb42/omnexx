import { describe, expect, it, vi } from 'vitest';

import { realClock } from '../../../src/core/clock.js';

describe('realClock.sleep abort race', () => {
  it('attaches no abort listener when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    await expect(realClock.sleep(500, controller.signal)).rejects.toThrow('aborted');
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it('removes its abort listener once the sleep finishes', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await realClock.sleep(5, controller.signal);
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

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
