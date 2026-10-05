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

function lineFor(e: OmnexxEvent): Line | undefined {
  if (e.type === 'tool.call') return toolLine(e);
  switch (e.type) {
    case 'run.start':
      return ['quiet', 'info', 'start', `run ${e.runId}${e.mode ? ` (${str(e.mode)})` : ''}`];
    case 'run.resume':
      return ['quiet', 'info', 'resume', `run ${e.runId}`];
    case 'run.finish':
      return [
        'quiet',
        e.status === 'finished' || e.status === 'planned' ? 'ok' : 'warn',
        'finish',
        `${str(e.status)}${e.reason ? `: ${str(e.reason)}` : ''} · ${fmtUsd(num(e.usd))}`,
      ];
    case 'run.error':
      return ['quiet', 'bad', 'error', clip(str(e.message ?? e.error), 100)];
    case 'planner.start':
      return ['normal', 'act', 'plan', 'reading the repo and writing the plan'];
    case 'plan.written':
      return [
        'quiet',
        'ok',
        'plan',
        `${num(e.nodes)} nodes (${str(e.mode)}) · ${num(e.turns)} turns · ${fmtUsd(num(e.usd))}`,
      ];
    case 'cycle.start':
      return ['quiet', 'info', `cycle ${e.cycle}`, `task ${str(e.task)}`];
    case 'turn': {
      const t = (e.tokens ?? {}) as Record<string, unknown>;
      const input = num(t.uncached) + num(t.cacheWrite) + num(t.cacheRead);
      const via = e.provider ? `${str(e.provider)}:` : '';
      return [
        'verbose',
        'info',
        'model',
        `${via}${str(e.model)}  in ${fmtTokens(input)} out ${fmtTokens(num(t.output))} · cache ${Math.round(num(e.cacheReadShare) * 100)}% · ${fmtUsd(num(e.usd))}${e.ms ? ` · ${fmtMs(num(e.ms))}` : ''}`,
      ];
    }
    case 'route.decision':
      return [
        'normal',
        'info',
        'route',
        `${str(e.action)} → ${str(e.model)}${e.by ? `  ${str(e.by)}` : ''}${e.probability !== undefined ? ` p=${num(e.probability).toFixed(2)}` : ''}${e.ms !== undefined ? `  ${fmtMs(num(e.ms))}` : ''}`,
      ];
    case 'tool.denied':
      return ['normal', 'bad', 'denied', `${str(e.rule)}: ${clip(str(e.reason), 80)}`];
    case 'verify.gates': {
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
    }
    case 'verify.flaky':
      return ['normal', 'warn', 'flaky', clip(JSON.stringify(e.ids ?? e.tests ?? ''), 80)];
    case 'verify.result': {
      const accepted = e.verdict === 'accept';
      const reasons = Array.isArray(e.reasons) ? e.reasons.map(str).join('; ') : '';
      return [
        accepted ? 'normal' : 'quiet',
        accepted ? 'ok' : 'bad',
        accepted ? 'accept' : 'reject',
        `${str(e.task)}${e.done ? ' (done)' : ''}${reasons ? `  ${clip(reasons, 80)}` : ''}`,
      ];
    }
    case 'commit': {
      const d = (e.diff ?? {}) as Record<string, unknown>;
      const stats =
        d.files !== undefined ? `  ${num(d.files)} files +${num(d.added)} −${num(d.removed)}` : '';
      return ['quiet', 'ok', 'commit', `${str(e.sha).slice(0, 7)}  ${str(e.task)}${stats}`];
    }
    case 'rollback':
      return ['quiet', 'warn', 'rollback', `to ${str(e.to).slice(0, 7)}`];
    case 'task.done':
      return ['normal', 'ok', 'done', `task ${str(e.task)}`];
    case 'task.parked':
      return ['quiet', 'warn', 'parked', `${str(e.task)}: ${clip(str(e.reason), 80)}`];
    case 'task.split':
      return ['normal', 'info', 'split', str(e.task)];
    case 'milestone.done':
      return ['quiet', 'ok', 'milestone', `${str(e.milestone)} ✓ (${num(e.tasks)} tasks)`];
    case 'ladder.rung':
      return ['normal', 'warn', 'ladder', `${str(e.rung)}${e.task ? ` on ${str(e.task)}` : ''}`];
    case 'stuck.signal':
    case 'stuck.in_cycle':
      return [
        'normal',
        'warn',
        'stuck',
        `${str(e.signal)}${e.detail ? `: ${clip(str(e.detail), 70)}` : ''}`,
      ];
    case 'context.cleared':
      return [
        'verbose',
        'info',
        'ctx',
        `cleared ${num(e.cleared)} old results  ${fmtTokens(num(e.tokensBefore))} → ${fmtTokens(num(e.tokensAfter))}`,
      ];
    case 'context.compacted':
      return [
        'normal',
        'info',
        'compact',
        `${num(e.turnsSummarized)} turns  ${fmtTokens(num(e.tokensBefore))} → ${fmtTokens(num(e.tokensAfter))}`,
      ];
    case 'context.compact_failed':
      return ['verbose', 'warn', 'compact', `skipped: ${clip(str(e.reason), 70)}`];
    case 'provider.failover':
      return [
        'normal',
        'warn',
        'failover',
        `${str(e.provider)}:${str(e.model)}  ${clip(str(e.error), 60)}`,
      ];
    case 'provider.retry':
      return ['verbose', 'warn', 'retry', `attempt ${num(e.attempt)} in ${fmtMs(num(e.delayMs))}`];
    case 'provider.outage':
      return [
        'quiet',
        'bad',
        'outage',
        `providers down for ${fmtMs(num(e.outageMs))}; backing off`,
      ];
    case 'provider.recovered':
      return ['quiet', 'ok', 'recovered', `after ${fmtMs(num(e.outageMs))}`];
    case 'budget.warn':
      return ['quiet', 'warn', 'budget', `${Math.round(num(e.warnAt) * 100)}% used`];
    case 'budget.stop':
    case 'budget.preflight_stop':
      return ['quiet', 'bad', 'budget', `stop: ${str(e.stop)} ${clip(str(e.detail), 60)}`];
    case 'budget.daily_pause':
      return ['quiet', 'warn', 'budget', 'daily cap reached; pausing'];
    case 'budget.daily_resume':
      return ['quiet', 'info', 'budget', 'daily window rolled; resuming'];
    case 'control.paused':
      return ['quiet', 'warn', 'paused', ''];
    case 'control.resumed':
      return ['quiet', 'info', 'resumed', ''];
    case 'judge.next_move':
      return ['verbose', 'info', 'judge', `next move ${str(e.pick ?? e.move)}`];
    case 'notes.update':
      return ['verbose', 'info', 'lesson', clip(str(e.text ?? e.id), 70)];
    case 'intent.update':
      return ['quiet', 'ok', 'intent', clip(str(e.product), 90)];
    case 'beyond.start':
      return [
        'quiet',
        'info',
        'beyond',
        `goal met; planning improvement round ${num(e.round)}/${num(e.maxRounds)}`,
      ];
    case 'beyond.round':
      return num(e.added)
        ? ['quiet', 'ok', 'beyond', `round ${num(e.round)}: ${num(e.added)} new nodes`]
        : ['quiet', 'info', 'beyond', `round ${num(e.round)}: nothing worth doing; wrapping up`];
    case 'beyond.skip':
      return ['normal', 'info', 'beyond', `skipped: ${str(e.reason)}`];
    case 'goal.changed':
      return ['quiet', 'info', 'steer', 'goal updated; picked up this cycle'];
    case 'codemap.updated':
      return ['verbose', 'info', 'codemap', `${num(e.files)} files`];
    case 'phase':
    case 'notify.sent':
    case 'cycle.context':
    case 'cycle.recorded':
      return undefined;
    default:
      return ['debug', 'info', clip(e.type, 10), ''];
  }
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
