import { Box, Text } from 'ink';
import { supervisorAlive } from '../cli/commands/control.js';
import { planCounts } from '../core/plan.js';
import type { OmnexxPaths } from '../core/paths.js';
import { listRunIds, RunStore } from '../core/run-store.js';
import { fmtMs } from '../telemetry/humanize.js';
import { CYAN, GRAY, GREEN, RED } from './colors.js';

export interface AgentRow {
  runId: string;
  repo: string;
  status: string;
  phase: string;
  alive: boolean;
  done: number;
  tasks: number;
  task: string | undefined;
  usd: number;
  /** ms since the supervisor's last heartbeat. */
  beatAge: number | undefined;
  goal: string;
}

export interface AgentsState {
  rows: AgentRow[];
  cursor: number;
}

/** Every long run on this machine (chats excluded), newest first, live ones on top. */
export async function loadAgents(paths: OmnexxPaths, now: number): Promise<AgentRow[]> {
  const ids = (await listRunIds(paths)).filter((id) => !id.startsWith('chat_')).reverse();
  const rows: AgentRow[] = [];
  for (const id of ids.slice(0, 40)) {
    const store = new RunStore(paths, id);
    const state = await store.readState().catch(() => undefined);
    if (!state) continue;
    const [plan, beat, alive, goal] = await Promise.all([
      store.readPlan().catch(() => undefined),
      store.readHeartbeat().catch(() => undefined),
      supervisorAlive(store).catch(() => false),
      store.readGoal().catch(() => ({ text: '' })),
    ]);
    const c = plan ? planCounts(plan) : undefined;
    rows.push({
      runId: id,
      repo: state.repoName,
      status: state.status,
      phase: state.phase,
      alive,
      done: c?.done ?? 0,
      tasks: c?.tasks ?? 0,
      task: state.taskId,
      usd: state.spend.usd,
      beatAge: beat ? now - beat.ts : undefined,
      goal:
        goal.text
          .split('\n')
          .find((l) => l.trim() && !l.startsWith('#'))
          ?.trim() ?? '',
    });
  }
  return rows.sort((a, b) => Number(b.alive) - Number(a.alive));
}

const bar = (done: number, total: number, width = 8): string => {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
};

export function AgentsView({ state, width }: { state: AgentsState; width: number }) {
  const live = state.rows.filter((r) => r.alive).length;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={GREEN} paddingX={1} width={width}>
      <Text>
        <Text color={GREEN} bold>
          agents
        </Text>
        <Text
          color={GRAY}
        >{`  ${live} running · ${state.rows.length} total · ↑↓ · enter attach · p pause/resume · s stop · esc`}</Text>
      </Text>
      {state.rows.length === 0 && (
        <Text color={GRAY}>no runs yet: /run &lt;goal&gt; starts one</Text>
      )}
      {state.rows.map((r, i) => (
        <Text key={r.runId} inverse={i === state.cursor} wrap="truncate-end">
          <Text color={r.alive ? GREEN : r.status === 'error' ? RED : GRAY}>
            {r.alive ? '● ' : '○ '}
          </Text>
          <Text color={CYAN}>{r.repo.padEnd(14).slice(0, 14)}</Text>
          <Text>{` ${r.alive ? r.phase.padEnd(9) : r.status.padEnd(9)} `}</Text>
          <Text color={GREEN}>{bar(r.done, r.tasks)}</Text>
          <Text
            color={GRAY}
          >{` ${r.done}/${r.tasks} ${r.task ?? ''} $${r.usd.toFixed(2)}${r.alive && r.beatAge !== undefined ? ` · ${fmtMs(r.beatAge)} ago` : ''}  ${r.goal.slice(0, 60)}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
