import type { Brand } from '../cli/brand.js';
import type { OmnexxEvent } from '../core/events.js';

/**
 * One short, brand-styled line per event: what the agent is doing right now. Pure, so the
 * TUI rail, `run` in line mode and `logs` all render the same feed.
 */

export const VERBOSITIES = ['quiet', 'normal', 'verbose', 'debug'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

const RANK: Record<Verbosity, number> = { quiet: 0, normal: 1, verbose: 2, debug: 3 };

export interface HumanizeOptions {
  brand: Brand;
  verbosity: Verbosity;
  /** Prefix lines with HH:MM:SS (local time). Off in tests that pin output. */
  clock?: boolean;
  /** Timezone-independent formatting for tests. */
  utc?: boolean;
}

type Line = [level: Verbosity, glyph: Glyph, verb: string, detail: string];
type Glyph = 'act' | 'ok' | 'bad' | 'warn' | 'info';

const str = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : v == null
        ? ''
        : JSON.stringify(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m${Math.round((ms % 60_000) / 1_000)}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

const fmtUsd = (usd: number): string => (usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);

/** The parsed tool input, or undefined when the summary was truncated or isn't JSON. */
function toolInput(e: OmnexxEvent): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(str(e.input));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function toolLine(e: OmnexxEvent): Line {
  const name = str(e.tool);
  const input = toolInput(e) ?? {};
  const path = str(input.path);
  const took = num(e.ms) >= 1_000 ? `  ${fmtMs(num(e.ms))}` : '';
  const glyph: Glyph = e.isError ? 'bad' : 'act';
  const err = e.isError ? '  ✗' : '';
  switch (name) {
    case 'read': {
      const range =
        input.start !== undefined
          ? `:${str(input.start)}-${input.end !== undefined ? str(input.end) : ''}`
          : '';
      return ['normal', glyph, 'read', `${path}${range}${err}`];
    }
    case 'outline':
      return ['normal', glyph, 'outline', `${path}${err}`];
    case 'search':
      return [
        'normal',
        glyph,
        'search',
        `/${clip(str(input.pattern), 50)}/${input.glob ? ` ${str(input.glob)}` : ''}${err}`,
      ];
    case 'str_replace':
    case 'multi_edit': {
      const edits = Array.isArray(input.edits) ? ` (${input.edits.length} edits)` : '';
      return ['normal', glyph, 'edit', `${path}${edits}${err}`];
    }
    case 'write_file':
      return ['normal', glyph, 'write', `${path}${err}`];
    case 'bash':
      return ['normal', glyph, 'bash', `${clip(str(input.command), 70)}${took}${err}`];
    case 'read_log':
      return ['verbose', glyph, 'log', `${str(input.id)}${err}`];
    case 'remember':
      return ['normal', glyph, 'note', `${str(input.action)} ${clip(str(input.text), 60)}`];
    default:
      return ['normal', glyph, clip(name, 8), `${clip(str(e.input), 70)}${took}${err}`];
  }
}

type Formatter = (e: OmnexxEvent) => Line | undefined;

const runStartLine: Formatter = (e) => {
  return ['quiet', 'info', 'start', `run ${e.runId}${e.mode ? ` (${str(e.mode)})` : ''}`];
};

const runResumeLine: Formatter = (e) => {
  return ['quiet', 'info', 'resume', `run ${e.runId}`];
};

const runFinishLine: Formatter = (e) => {
  return [
    'quiet',
    e.status === 'finished' || e.status === 'planned' ? 'ok' : 'warn',
    'finish',
    `${str(e.status)}${e.reason ? `: ${str(e.reason)}` : ''} · ${fmtUsd(num(e.usd))}`,
  ];
};

const runErrorLine: Formatter = (e) => {
  return ['quiet', 'bad', 'error', clip(str(e.message ?? e.error), 100)];
};

const plannerStartLine: Formatter = () => {
  return ['normal', 'act', 'plan', 'reading the repo and writing the plan'];
};

const planWrittenLine: Formatter = (e) => {
  return [
    'quiet',
    'ok',
    'plan',
    `${num(e.nodes)} nodes (${str(e.mode)}) · ${num(e.turns)} turns · ${fmtUsd(num(e.usd))}`,
  ];
};

const cycleStartLine: Formatter = (e) => {
  return ['quiet', 'info', `cycle ${e.cycle}`, `task ${str(e.task)}`];
};

const f8: Formatter = (e) => {
  const t = (e.tokens ?? {}) as Record<string, unknown>;
  const input = num(t.uncached) + num(t.cacheWrite) + num(t.cacheRead);
  const via = e.provider ? `${str(e.provider)}:` : '';
  return [
    'verbose',
    'info',
    'model',
    `${via}${str(e.model)}  in ${fmtTokens(input)} out ${fmtTokens(num(t.output))} · cache ${Math.round(num(e.cacheReadShare) * 100)}% · ${fmtUsd(num(e.usd))}${e.ms ? ` · ${fmtMs(num(e.ms))}` : ''}`,
  ];
};

const routeDecisionLine: Formatter = (e) => {
  return [
    'normal',
    'info',
    'route',
    `${str(e.action)} → ${str(e.model)}${e.by ? `  ${str(e.by)}` : ''}${e.probability !== undefined ? ` p=${num(e.probability).toFixed(2)}` : ''}${e.ms !== undefined ? `  ${fmtMs(num(e.ms))}` : ''}`,
  ];
};

const toolDeniedLine: Formatter = (e) => {
  return ['normal', 'bad', 'denied', `${str(e.rule)}: ${clip(str(e.reason), 80)}`];
};

const verifyGatesLine: Formatter = (e) => {
  const gates = Array.isArray(e.gates) ? (e.gates as Record<string, unknown>[]) : [];
  return [
    'normal',
    gates.every((g) => num(g.exitCode) === 0) ? 'ok' : 'bad',
    'gates',
    gates
      .map((g) => {
        const t = g.tests as Record<string, unknown> | undefined;
        const mark = num(g.exitCode) === 0 ? '✓' : '✗';
        const counts = t ? ` ${num(t.passed)}/${num(t.total)}` : '';
        const fresh = num(g.newFailures) ? ` +${num(g.newFailures)} new` : '';
        return `${str(g.gate)} ${mark}${counts}${fresh} (${fmtMs(num(g.durationMs))})`;
      })
      .join('  '),
  ];
};

const verifyFlakyLine: Formatter = (e) => {
  return ['normal', 'warn', 'flaky', clip(JSON.stringify(e.ids ?? e.tests ?? ''), 80)];
};

const verifyResultLine: Formatter = (e) => {
  const accepted = e.verdict === 'accept';
  const reasons = Array.isArray(e.reasons) ? e.reasons.map(str).join('; ') : '';
  return [
    accepted ? 'normal' : 'quiet',
    accepted ? 'ok' : 'bad',
    accepted ? 'accept' : 'reject',
    `${str(e.task)}${e.done ? ' (done)' : ''}${reasons ? `  ${clip(reasons, 80)}` : ''}`,
  ];
};

const f14: Formatter = (e) => {
  const d = (e.diff ?? {}) as Record<string, unknown>;
  const stats =
    d.files !== undefined ? `  ${num(d.files)} files +${num(d.added)} −${num(d.removed)}` : '';
  return ['quiet', 'ok', 'commit', `${str(e.sha).slice(0, 7)}  ${str(e.task)}${stats}`];
};

const f15: Formatter = (e) => {
  return ['quiet', 'warn', 'rollback', `to ${str(e.to).slice(0, 7)}`];
};

const taskDoneLine: Formatter = (e) => {
  return ['normal', 'ok', 'done', `task ${str(e.task)}`];
};

const taskParkedLine: Formatter = (e) => {
  return ['quiet', 'warn', 'parked', `${str(e.task)}: ${clip(str(e.reason), 80)}`];
};

const taskSplitLine: Formatter = (e) => {
  return ['normal', 'info', 'split', str(e.task)];
};

const milestoneDoneLine: Formatter = (e) => {
  return ['quiet', 'ok', 'milestone', `${str(e.milestone)} ✓ (${num(e.tasks)} tasks)`];
};

const ladderRungLine: Formatter = (e) => {
  return ['normal', 'warn', 'ladder', `${str(e.rung)}${e.task ? ` on ${str(e.task)}` : ''}`];
};

const stuckSignalLine: Formatter = (e) => {
  return [
    'normal',
    'warn',
    'stuck',
    `${str(e.signal)}${e.detail ? `: ${clip(str(e.detail), 70)}` : ''}`,
  ];
};

const cycleContextLine: Formatter = (e) => {
  const t = (e.tokens ?? {}) as Record<string, number>;
  const parts = Object.entries(t)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k} ${fmtTokens(v)}`);
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  return [
    'verbose',
    'info',
    'ctx',
    parts.length ? `${fmtTokens(total)}: ${parts.join(' · ')}` : '',
  ];
};

const contextClearedLine: Formatter = (e) => {
  return [
    'verbose',
    'info',
    'ctx',
    `cleared ${num(e.cleared)} old results  ${fmtTokens(num(e.tokensBefore))} → ${fmtTokens(num(e.tokensAfter))}`,
  ];
};

const contextCompactedLine: Formatter = (e) => {
  return [
    'normal',
    'info',
    'compact',
    `${num(e.turnsSummarized)} turns  ${fmtTokens(num(e.tokensBefore))} → ${fmtTokens(num(e.tokensAfter))}`,
  ];
};

const contextCompactFailedLine: Formatter = (e) => {
  return ['verbose', 'warn', 'compact', `skipped: ${clip(str(e.reason), 70)}`];
};

const providerFailoverLine: Formatter = (e) => {
  return [
    'normal',
    'warn',
    'failover',
    `${str(e.provider)}:${str(e.model)}  ${clip(str(e.error), 60)}`,
  ];
};

const providerRetryLine: Formatter = (e) => {
  return ['verbose', 'warn', 'retry', `attempt ${num(e.attempt)} in ${fmtMs(num(e.delayMs))}`];
};

const providerOutageLine: Formatter = (e) => {
  return ['quiet', 'bad', 'outage', `providers down for ${fmtMs(num(e.outageMs))}; backing off`];
};

const providerRecoveredLine: Formatter = (e) => {
  return ['quiet', 'ok', 'recovered', `after ${fmtMs(num(e.outageMs))}`];
};

const budgetWarnLine: Formatter = (e) => {
  return ['quiet', 'warn', 'budget', `${Math.round(num(e.warnAt) * 100)}% used`];
};

const budgetStopLine: Formatter = (e) => {
  return ['quiet', 'bad', 'budget', `stop: ${str(e.stop)} ${clip(str(e.detail), 60)}`];
};

const budgetDailyPauseLine: Formatter = () => {
  return ['quiet', 'warn', 'budget', 'daily cap reached; pausing'];
};

const budgetDailyResumeLine: Formatter = () => {
  return ['quiet', 'info', 'budget', 'daily window rolled; resuming'];
};

const controlPausedLine: Formatter = () => {
  return ['quiet', 'warn', 'paused', ''];
};

const controlResumedLine: Formatter = () => {
  return ['quiet', 'info', 'resumed', ''];
};

const judgeNextMoveLine: Formatter = (e) => {
  return ['verbose', 'info', 'judge', `next move ${str(e.pick ?? e.move)}`];
};

const notesUpdateLine: Formatter = (e) => {
  return ['verbose', 'info', 'lesson', clip(str(e.text ?? e.id), 70)];
};

const goalChangedLine: Formatter = () => {
  return ['quiet', 'info', 'steer', 'goal updated; picked up this cycle'];
};

const codemapUpdatedLine: Formatter = (e) => {
  return ['verbose', 'info', 'codemap', `${num(e.files)} files`];
};

/** One formatter per event type; types not listed are debug-only. */
const FORMATTERS: Partial<Record<string, Formatter>> = {
  'run.start': runStartLine,
  'run.resume': runResumeLine,
  'run.finish': runFinishLine,
  'run.error': runErrorLine,
  'planner.start': plannerStartLine,
  'plan.written': planWrittenLine,
  'cycle.start': cycleStartLine,
  turn: f8,
  'route.decision': routeDecisionLine,
  'tool.denied': toolDeniedLine,
  'verify.gates': verifyGatesLine,
  'verify.flaky': verifyFlakyLine,
  'verify.result': verifyResultLine,
  commit: f14,
  rollback: f15,
  'task.done': taskDoneLine,
  'task.parked': taskParkedLine,
  'task.split': taskSplitLine,
  'milestone.done': milestoneDoneLine,
  'ladder.rung': ladderRungLine,
  'stuck.signal': stuckSignalLine,
  'stuck.in_cycle': stuckSignalLine,
  'cycle.context': cycleContextLine,
  'context.cleared': contextClearedLine,
  'context.compacted': contextCompactedLine,
  'context.compact_failed': contextCompactFailedLine,
  'provider.failover': providerFailoverLine,
  'provider.retry': providerRetryLine,
  'provider.outage': providerOutageLine,
  'provider.recovered': providerRecoveredLine,
  'budget.warn': budgetWarnLine,
  'budget.stop': budgetStopLine,
  'budget.preflight_stop': budgetStopLine,
  'budget.daily_pause': budgetDailyPauseLine,
  'budget.daily_resume': budgetDailyResumeLine,
  'control.paused': controlPausedLine,
  'control.resumed': controlResumedLine,
  'judge.next_move': judgeNextMoveLine,
  'notes.update': notesUpdateLine,
  'goal.changed': goalChangedLine,
  'codemap.updated': codemapUpdatedLine,
};

/** Internal events that never show, even at debug (debug prints them raw). */
const HIDDEN = new Set(['phase', 'notify.sent', 'cycle.recorded']);

function lineFor(e: OmnexxEvent): Line | undefined {
  if (e.type === 'tool.call') return toolLine(e);
  if (HIDDEN.has(e.type)) return undefined;
  const format = FORMATTERS[e.type];
  return format ? format(e) : ['debug', 'info', clip(e.type, 10), ''];
}

export function humanize(e: OmnexxEvent, opts: HumanizeOptions): string | undefined {
  const line = lineFor(e);
  if (!line) return opts.verbosity === 'debug' ? debugLine(e, opts) : undefined;
  const [level, glyph, verb, detail] = line;
  if (RANK[level] > RANK[opts.verbosity]) return undefined;
  const b = opts.brand;
  const marks: Record<Glyph, string> = {
    ok: b.green('✓'),
    bad: b.red('✗'),
    warn: b.yellow('!'),
    act: b.cyan('▸'),
    info: b.dim('·'),
  };
  const mark = marks[glyph];
  const paintVerb: Partial<Record<Glyph, (s: string) => string>> = { ok: b.green, bad: b.red };
  const v = (paintVerb[glyph] ?? String)(verb.padEnd(8));
  const time = opts.clock === false ? '' : `${b.dim(clockOf(e.ts, opts.utc))} `;
  return `${time}${mark} ${v} ${detail}`.trimEnd();
}

function debugLine(e: OmnexxEvent, opts: HumanizeOptions): string {
  const rest = Object.fromEntries(
    Object.entries(e).filter(([k]) => !['ts', 'runId', 'cycle', 'type'].includes(k)),
  );
  const type = e.type;
  const time = opts.clock === false ? '' : `${opts.brand.dim(clockOf(e.ts, opts.utc))} `;
  return `${time}${opts.brand.dim('·')} ${type.padEnd(8)} ${clip(JSON.stringify(rest), 120)}`;
}

function clockOf(ts: number, utc = false): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return utc
    ? `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `--quiet` / `--verbose` / `--debug` flags → a verbosity (the loudest flag wins). */
export function verbosityFrom(f: {
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
}): Verbosity {
  if (f.debug) return 'debug';
  if (f.verbose) return 'verbose';
  return f.quiet ? 'quiet' : 'normal';
}
