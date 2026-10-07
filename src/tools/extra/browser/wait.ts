import type { WaitTarget } from './types.js';

export const describeWaitTarget = (t: WaitTarget): string =>
  'text' in t ? `text "${t.text}"` : `element ${t.selector}`;

/**
 * Polls `check` until it is true. Backends poll instead of using a blocking native wait:
 * agent-browser's daemon stays busy on a wait for an element that never appears, and every
 * later command then fails.
 */
export async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() >= deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
