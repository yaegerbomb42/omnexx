/**
 * BudgetGate adapter for the 24/7 daemon.
 *
 * `AutonomousDaemon` parks in BUDGET_PAUSE when its injected `BudgetGate`
 * reports not-ok; this module adapts the real `DaemonBudgetGovernor` to that
 * narrow interface. The gate is a pure read of the governor's rolling
 * windows — it never records usage (only the planner/executor call path does,
 * via `DaemonBudgetGovernor.recordUsage`) — so a check is safe to run every
 * cycle.
 *
 * Ledger: the governor's own `JsonFileBudgetLedger` at
 * `<repoRoot>/.omnexx/budget_ledger.json` (the store's `budget_ledger` table
 * holds windowed aggregates written by nobody in production yet, so it is
 * not a usable spend source). Price card is empty: the gate reads the
 * ledger's recorded USD directly and never prices a new call.
 */
import { join } from 'node:path';
import type { AutonomousConfig } from '../config/sections/autonomous.js';
import type { Usage } from '../providers/types.js';
import {
  DaemonBudgetGovernor,
  JsonFileBudgetLedger,
  type BudgetLedger,
  type DaemonBudgetCaps,
} from '../core/budgetGovernor.js';
import type { BudgetGate } from './daemon.js';

/** The two governor reads the gate needs (a structural type, so tests can stub it). */
export interface BudgetGateSource {
  windowUsage(nowMs: number): {
    hourTokens: number;
    hourUsd: number;
    dayTokens: number;
    dayUsd: number;
  };
  isCircuitOpen(): boolean;
}

/** Rolling-window caps the gate enforces, in tokens and USD. */
export interface BudgetGateCaps {
  hourTokens: number;
  hourUsd: number;
  dayTokens: number;
  dayUsd: number;
}

/**
 * Adapt a governor (or a stub with the same two reads) to the daemon's
 * `BudgetGate`. A window reports not-ok as soon as its usage reaches the cap:
 * at the cap there is no headroom left for the next model call, so the daemon
 * parks instead of starting work it cannot pay for.
 */
export function createDaemonBudgetGate(
  governor: BudgetGateSource,
  caps: BudgetGateCaps,
): BudgetGate {
  return {
    check(nowMs: number): Promise<{ ok: boolean; reason?: string }> {
      return Promise.resolve(evaluateBudgetGate(governor, caps, nowMs));
    },
  };
}

/** Pure evaluation behind `createDaemonBudgetGate` (kept sync for tests). */
function evaluateBudgetGate(
  governor: BudgetGateSource,
  caps: BudgetGateCaps,
  nowMs: number,
): { ok: boolean; reason?: string } {
  if (governor.isCircuitOpen()) {
    return {
      ok: false,
      reason:
        'budget circuit breaker open: unproductive spend with zero SHIPs — human inspection needed',
    };
  }
  const usage = governor.windowUsage(nowMs);
  if (usage.hourTokens >= caps.hourTokens) {
    return {
      ok: false,
      reason: `hourly token cap reached (${usage.hourTokens.toLocaleString()} / ${caps.hourTokens.toLocaleString()} tokens in the last hour)`,
    };
  }
  if (usage.hourUsd >= caps.hourUsd) {
    return {
      ok: false,
      reason: `hourly spend cap reached ($${usage.hourUsd.toFixed(2)} / $${caps.hourUsd.toFixed(2)} in the last hour)`,
    };
  }
  if (usage.dayTokens >= caps.dayTokens) {
    return {
      ok: false,
      reason: `daily token cap reached (${usage.dayTokens.toLocaleString()} / ${caps.dayTokens.toLocaleString()} tokens in the last 24 hours)`,
    };
  }
  if (usage.dayUsd >= caps.dayUsd) {
    return {
      ok: false,
      reason: `daily spend cap reached ($${usage.dayUsd.toFixed(2)} / $${caps.dayUsd.toFixed(2)} in the last 24 hours)`,
    };
  }
  return { ok: true };
}

export interface BuildDaemonBudgetGateOptions {
  repoRoot: string;
  budget: AutonomousConfig['budget'];
  /** `--max-cost-day` override for the daily USD cap. */
  maxCostDayUsd?: number;
  /** Test seam: supply a ledger instead of the JSON file. */
  ledger?: BudgetLedger;
  /** Test seam: override the JSON ledger path. */
  ledgerPath?: string;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Usage recording (planner/executor → ledger)
// ---------------------------------------------------------------------------

/**
 * One priced model call, as the planner/executor report it. The caller
 * prices the call from the `ResolvedModel` that made it (`costUsd` in
 * `src/providers/pricing.ts`): the governor's price card is empty by design,
 * so the ledger would price every call at $0 if it did the pricing itself.
 */
export interface DaemonUsageReport {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  /** USD cost of the call, priced by the caller from the model that made it. */
  usd: number;
}

/** Callback the planner/executor invoke after each successful model call. */
export type DaemonUsageRecorder = (report: DaemonUsageReport) => void;

/** Split a provider `Usage` into billed input/output token counts. */
export function usageTokenTotals(usage: Usage): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: usage.uncached + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead,
    outputTokens: usage.output,
  };
}

/**
 * Build the recorder the planner/executor call after each successful model
 * call: it writes the priced call straight into the budget ledger, so the
 * gate's rolling windows (and the `--max-cost-day` cap) actually see the
 * daemon's spend. Without this, the gate reads an empty ledger and the caps
 * can never trip.
 */
export function createUsageRecorder(
  ledger: BudgetLedger,
  now: () => number = Date.now,
): DaemonUsageRecorder {
  return (report: DaemonUsageReport) => {
    ledger.record({
      at: now(),
      usd: report.usd,
      tokens: report.inputTokens + report.outputTokens,
      taskId: report.taskId,
      shipped: false,
    });
  };
}

/**
 * Build the governor + gate pair the daemon runs with: caps mapped from
 * `[autonomous.budget]` (with the `--max-cost-day` override applied to the
 * daily USD cap) over the JSON-file ledger.
 */
export function buildDaemonBudgetGate(options: BuildDaemonBudgetGateOptions): {
  gate: BudgetGate;
  governor: DaemonBudgetGovernor;
  ledger: BudgetLedger;
  ledgerPath: string;
  caps: DaemonBudgetCaps;
} {
  const ledgerPath = options.ledgerPath ?? join(options.repoRoot, '.omnexx', 'budget_ledger.json');
  const ledger = options.ledger ?? new JsonFileBudgetLedger(ledgerPath);
  const caps: DaemonBudgetCaps = {
    taskSoftTokens: options.budget.max_tokens_per_task_soft,
    taskSoftWarnAt: 0.8,
    taskHardTokens: options.budget.max_tokens_per_task_hard,
    taskHardUsd: options.budget.max_cost_usd_per_task,
    hourTokens: options.budget.max_tokens_per_hour,
    hourUsd: options.budget.max_cost_usd_per_hour,
    dayTokens: options.budget.max_tokens_per_day,
    dayUsd: options.maxCostDayUsd ?? options.budget.max_cost_usd_per_day,
    unproductiveUsd: options.budget.max_unproductive_spend_usd,
  };
  const governor = new DaemonBudgetGovernor({
    ledger,
    // Empty price card: the gate reads recorded USD straight from the ledger;
    // pricing new calls (recordUsage) is the planner/executor path's job and
    // needs the model that made the call, which the gate never sees.
    priceCard: {},
    caps,
    ...(options.now ? { now: options.now } : {}),
  });
  return { gate: createDaemonBudgetGate(governor, caps), governor, ledger, ledgerPath, caps };
}
