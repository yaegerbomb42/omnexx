/**
 * Observe-only System-1 telemetry: folded from the `system1.*` events the middleware emits, so
 * the CLI (`omnexx system1`), the chat server and the VS Code card all read the same numbers.
 */

export interface SystemOneObserveSnapshot {
  backend: string;
  model: string;
  intent: { label: string; confidence: number } | null;
  guardrail: { checked: number; intercepted: number };
  patch: { checked: number; caught: number };
  triage: { runs: number; linesPruned: number; tokensSaved: number };
  speculative: { hits: number };
  earlyStop: { turnsSaved: number; tokensSaved: number };
  tokensSaved: number;
  latencyP50Ms: number;
}

export const emptySystemOneSnapshot = (): SystemOneObserveSnapshot => ({
  backend: 'System-1 Local',
  model: 'calibrated-local',
  intent: null,
  guardrail: { checked: 0, intercepted: 0 },
  patch: { checked: 0, caught: 0 },
  triage: { runs: 0, linesPruned: 0, tokensSaved: 0 },
  speculative: { hits: 0 },
  earlyStop: { turnsSaved: 0, tokensSaved: 0 },
  tokensSaved: 0,
  latencyP50Ms: 0,
});

const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : d);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Fold one event into the snapshot (a new object; unrelated events return the same one). */
export function reduceSystemOneEvent(
  s: SystemOneObserveSnapshot,
  e: { type: string; [k: string]: unknown },
): SystemOneObserveSnapshot {
  if (!e.type.startsWith('system1.')) return s;
  const n = { ...s, latencyP50Ms: e.p50Ms === undefined ? s.latencyP50Ms : num(e.p50Ms) };
  switch (e.type) {
    case 'system1.backend':
      return { ...n, backend: str(e.label, s.backend), model: str(e.model, s.model) };
    case 'system1.guardrail':
      return {
        ...n,
        guardrail: {
          checked: s.guardrail.checked + 1,
          intercepted:
            s.guardrail.intercepted + (e.blocked === true || e.prompted === true ? 1 : 0),
        },
      };
    case 'system1.patch_sanity':
      return {
        ...n,
        patch: {
          checked: s.patch.checked + 1,
          caught: s.patch.caught + (e.rejected === true ? 1 : 0),
        },
      };
    case 'system1.triage':
      return {
        ...n,
        triage: {
          runs: s.triage.runs + 1,
          linesPruned: s.triage.linesPruned + num(e.linesPruned),
          tokensSaved: s.triage.tokensSaved + num(e.tokensSaved),
        },
        tokensSaved: s.tokensSaved + num(e.tokensSaved),
      };
    case 'system1.intent':
      return {
        ...n,
        intent: { label: str(e.intent), confidence: num(e.confidence) },
        speculative: { hits: s.speculative.hits + (e.speculated === true ? 1 : 0) },
        tokensSaved: s.tokensSaved + num(e.tokensSaved),
      };
    case 'system1.early_stop':
      return {
        ...n,
        earlyStop: {
          turnsSaved: s.earlyStop.turnsSaved + 1,
          tokensSaved: s.earlyStop.tokensSaved + num(e.tokensSaved),
        },
        tokensSaved: s.tokensSaved + num(e.tokensSaved),
      };
    default:
      return n;
  }
}

export function snapshotFromEvents(
  events: readonly { type: string; [k: string]: unknown }[],
): SystemOneObserveSnapshot | null {
  const s1 = events.filter((e) => e.type.startsWith('system1.'));
  return s1.length
    ? s1.reduce((acc, e) => reduceSystemOneEvent(acc, e), emptySystemOneSnapshot())
    : null;
}
