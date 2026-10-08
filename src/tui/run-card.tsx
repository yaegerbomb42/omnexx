import { Box, Text } from 'ink';
import { fmtMs } from '../telemetry/humanize.js';
import type { Telemetry } from '../telemetry/aggregate.js';
import { CYAN, GRAY, GREEN, RED } from './colors.js';

export interface RunCardInfo {
  runId: string;
  alive: boolean;
  phase: string | undefined;
  done: number;
  tasks: number;
  t: Telemetry;
  now: number;
}

const short = (ref: string): string => ref.split(':').pop() ?? ref;

/** Seconds since the last event, as a health word: quiet runs are fine, silent ones aren't. */
export function health(alive: boolean, lastAt: number | undefined, now: number): string {
  if (!alive) return 'stopped';
  const quiet = lastAt === undefined ? 0 : now - lastAt;
  if (quiet > 15 * 60_000) return `silent ${fmtMs(quiet)}`;
  return quiet > 60_000 ? `quiet ${fmtMs(quiet)}` : 'healthy';
}

/** The text rows of the live run card; pure, so tests can pin them. */
export function runCardRows(i: RunCardInfo): string[] {
  const t = i.t;
  const bar = (n: number, of: number, w = 16): string => {
    const k = of ? Math.round((n / of) * w) : 0;
    return '█'.repeat(k) + '░'.repeat(w - k);
  };
  const elapsed = t.startedAt ? fmtMs((t.lastAt ?? i.now) - t.startedAt) : '0s';
  const gates = t.gateRuns ? `${t.gatePasses}/${t.gateRuns}` : '–';
  return [
    `${i.phase ?? 'starting'} · cycle ${t.cycle} · ${elapsed} · ${health(i.alive, t.lastAt, i.now)}`,
    `${bar(i.done, i.tasks)} ${i.done}/${i.tasks} tasks · ${t.milestonesDone} milestone${t.milestonesDone === 1 ? '' : 's'}${t.task ? ` · now ${t.task}` : ''}`,
    `model ${t.model ? short(t.model) : '–'}${t.routeBy ? ` (${t.routeBy === 'judge' ? 'Nimble pick' : t.routeBy})` : ''} · ${t.failovers} switch${t.failovers === 1 ? '' : 'es'}${t.quotaOut.length ? ` · out of quota: ${t.quotaOut.map(short).join(', ')}` : ''}`,
    `✓ ${t.commits} kept · ✗ ${t.rejects} rejected · ↺ ${t.rollbacks} · gates ${gates} · stuck ${t.stuck} · $${t.usd.toFixed(2)}`,
  ];
}

const ROW_COLOR = [GREEN, CYAN, GRAY, GRAY];

/** Live card for the attached run: health, progress, model and outcomes at a glance. */
export function RunCard({ info, width }: { info: RunCardInfo; width: number }) {
  const rows = runCardRows(info);
  const sick = !info.alive || rows[0]?.includes('silent');
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={sick ? RED : GREEN}
      paddingX={1}
      width={width}
    >
      <Text>
        <Text color={sick ? RED : GREEN} bold>
          {info.alive ? '◉ ' : '○ '}
          {info.runId}
        </Text>
      </Text>
      {rows.map((r, k) => (
        <Text key={k} wrap="truncate-end" color={ROW_COLOR[k] ?? GRAY}>
          {r}
        </Text>
      ))}
    </Box>
  );
}
