/** Time is injected everywhere so outages, budgets and breakers are testable in milliseconds. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const reasonOf = (): Error => {
        const r = signal?.reason as unknown;
        return r instanceof Error ? r : new Error(String(r));
      };
      // An already-aborted signal never fires 'abort' again: reject now, and never leave a
      // listener behind on a long-lived signal that outlives this sleep.
      if (signal?.aborted) {
        reject(reasonOf());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(reasonOf());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
