import { parseLevels, type StoredAgentSettings } from '../config/agent-settings.js';
import {
  CONTEXT_BUDGETS,
  CONTEXT_LABELS,
  DEFAULT_LEVELS,
  levelsSummary,
  MAX_TOKEN_CHOICES,
  TASK_EFFORT_LABELS,
  TIME_CHOICES,
  TURN_EFFORT_LABELS,
} from '../core/agent-levels.js';
import type { Session } from '../tui/session.js';

/**
 * The editor's "Agent" card over the chat-server protocol.
 * In: agentSettings · setAgentSettings {levels, askOnStart}.
 * Out: agentSettings {levels, askOnStart, saved, summary, meta}: `saved` is false until the
 * person saved once (the card then shows the defaults); `meta` carries every level's label, so
 * the card says what a level means exactly as the terminal does.
 */

type Command = { type: string } & Record<string, unknown>;
type Write = (msg: object) => void;

export const AGENT_META = {
  task: TASK_EFFORT_LABELS,
  turn: TURN_EFFORT_LABELS,
  context: CONTEXT_BUDGETS.map((tokens, i) => ({ tokens, label: CONTEXT_LABELS[i] ?? '' })),
  time: TIME_CHOICES,
  tokens: MAX_TOKEN_CHOICES,
};

export function agentSettingsMessage(s: StoredAgentSettings): Record<string, unknown> {
  const levels = s.levels ?? DEFAULT_LEVELS;
  return {
    type: 'agentSettings',
    levels,
    askOnStart: s.askOnStart,
    saved: s.levels !== undefined,
    summary: levelsSummary(levels),
    meta: AGENT_META,
  };
}

/** Handle `agentSettings` (read) and `setAgentSettings` (save, then re-read the chat's config). */
export async function agentSettingsCommand(
  c: Command,
  session: Session,
  write: Write,
): Promise<void> {
  const host = session.agentSettings;
  if (c.type === 'agentSettings') {
    write(agentSettingsMessage(await host.load()));
    return;
  }
  if (typeof c.levels !== 'object' || c.levels === null)
    throw new Error('"setAgentSettings" needs a "levels" object');
  const saved = await host.save({
    levels: parseLevels(c.levels),
    askOnStart: c.askOnStart !== false,
  });
  write(agentSettingsMessage(saved));
  await session.reloadChat();
}
