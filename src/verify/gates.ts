import { join } from 'node:path';
import { parseDuration } from '../config/duration.js';
import type { GateConfig } from '../config/schema.js';
import { runShell } from '../core/exec.js';
import type { GateSnapshot } from '../core/run-store.js';
import { parseGateOutput } from './parsers/index.js';
import type { Failure, TestCounts } from './parsers/types.js';

export interface GateResult {
  name: string;
  level: GateConfig['level'];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  failures: Failure[];
  tests?: TestCounts;
  structured: boolean;
  logFile: string;
}

export interface GateRunContext {
  cwd: string;
  env: Record<string, string>;
  logsDir: string;
  /** e.g. `c12` or `baseline`; part of the log file name. */
  label: string;
  maxCmdTimeoutMs: number;
  redact: (s: string) => string;
  signal?: AbortSignal;
}

export async function runGate(gate: GateConfig, ctx: GateRunContext): Promise<GateResult> {
  const logFile = join(ctx.logsDir, `gate-${ctx.label}-${gate.name}.log`);
  const timeoutMs = Math.min(parseDuration(gate.timeout), ctx.maxCmdTimeoutMs);
  const r = await runShell(gate.run, {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs,
    logPath: logFile,
    redact: ctx.redact,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const parsed = parseGateOutput(gate.parser, r.output, {
    gate: gate.name,
    exitCode: r.exitCode,
    cwd: ctx.cwd,
  });
  return {
    name: gate.name,
    level: gate.level,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    failures: parsed.failures,
    ...(parsed.tests ? { tests: parsed.tests } : {}),
    structured: parsed.structured,
    logFile,
  };
}

/** Gates run one after another (they often share build output), fast ones first as configured. */
export async function runGates(
  gates: readonly GateConfig[],
  ctx: GateRunContext,
): Promise<GateResult[]> {
  const out: GateResult[] = [];
  for (const g of gates) out.push(await runGate(g, ctx));
  return out;
}

export function snapshot(r: GateResult): GateSnapshot {
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    failureIds: r.failures.map((f) => f.id),
    ...(r.tests ? { tests: r.tests } : {}),
  };
}

export const toBaseline = (results: readonly GateResult[]): Record<string, GateSnapshot> =>
  Object.fromEntries(results.map((r) => [r.name, snapshot(r)]));
