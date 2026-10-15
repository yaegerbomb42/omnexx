import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRunHistory } from '../../../src/core/run-history.js';
import { emptyTelemetry, type Telemetry } from '../../../src/telemetry/aggregate.js';
import { ChatEstimate } from '../../../src/tui/chat-estimate.js';
import { tempDir } from '../../support/tmp.js';

function spent(input: number, cacheRead: number, output: number, usd: number): Telemetry {
  return { ...emptyTelemetry(), tokens: { input, cacheRead, cacheWrite: 0, output }, usd };
}

const todos = (done: number, total: number) =>
  Array.from({ length: total }, (_, i) => ({
    text: `step ${i}`,
    status: i < done ? ('done' as const) : ('pending' as const),
  }));

describe('ChatEstimate', () => {
  it('estimates only work that follows a plan, then records it', async () => {
    const file = join(await tempDir(), 'run-history.json');
    const est = new ChatEstimate(file, { model: () => 'a:m', repoFiles: 10 });
    // No plan yet: an ordinary message gets no estimate.
    expect(await est.start(false, 0, emptyTelemetry())).toBeUndefined();
    est.planned(400, 3);
    expect(await est.start(true, 0, emptyTelemetry())).toBeUndefined();
    est.planned(400, 3);
    expect(await est.start(false, 1_000, spent(100, 0, 0, 0))).toBe('no history yet');
    expect(est.progress(todos(1, 3), 61_000)).toBe('~2 min left');
    await est.finish(true, 181_000, spent(5_100, 2_000, 500, 0.03));
    const saved = await loadRunHistory(file);
    expect(saved).toEqual([
      expect.objectContaining({
        kind: 'chat',
        nodes: 3,
        goalChars: 400,
        wallMs: 180_000,
        freshTokens: 3_500,
        cachedTokens: 2_000,
        usd: 0.03,
      }),
    ]);
    // The next approved plan is estimated from it.
    est.planned(380, 3);
    expect(await est.start(false, 0, emptyTelemetry())).toMatch(/^est\. ~3 min, ~6k tokens/);
  });

  it('does not record stopped work or progress outside approved work', async () => {
    const file = join(await tempDir(), 'run-history.json');
    const est = new ChatEstimate(file, { model: () => 'a:m', repoFiles: 10 });
    expect(est.progress(todos(1, 2), 1)).toBeUndefined();
    est.planned(10, 1);
    await est.start(false, 0, emptyTelemetry());
    await est.finish(false, 5_000, emptyTelemetry());
    expect(await loadRunHistory(file)).toEqual([]);
  });
});
