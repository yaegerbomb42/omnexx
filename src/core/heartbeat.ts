import type { Run } from './run.js';

export const HEARTBEAT_MS = 15_000;
export const STALE_AFTER_MS = 120_000;

/** Write heartbeat.json now and every `intervalMs`. The timer never keeps the process alive. */
export function startHeartbeat(
  run: Run,
  intervalMs = HEARTBEAT_MS,
  paused: () => boolean = () => false,
): () => void {
  const beat = (): void => {
    void run.store
      .writeHeartbeat({
        ts: Date.now(),
        pid: process.pid,
        phase: paused() ? 'paused' : run.state.phase,
        status: paused() ? 'paused' : run.state.status,
        cycle: run.state.cycle,
        ...(run.state.taskId ? { task: run.state.taskId } : {}),
        spentUsd: run.state.spend.usd,
        lastGreen: run.state.lastGreen,
      })
      .catch(() => undefined);
  };
  beat();
  const t = setInterval(beat, intervalMs);
  t.unref();
  return () => {
    clearInterval(t);
  };
}
