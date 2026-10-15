import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OmnexxPaths } from '../core/paths.js';
import {
  agentBrief,
  clampLevel,
  contextProfile,
  DEFAULT_LEVELS,
  isTimeChoice,
  MAX_TOKEN_CHOICES,
  taskEffortProfile,
  timeHours,
  type AgentLevels,
} from '../core/agent-levels.js';

/**
 * The agent sliders, as the person set them in `/settings` or the VS Code "Agent" card, kept in
 * agent-settings.json next to roles.json. `levels` is undefined until they were saved once, so a
 * fresh install behaves exactly as before. They reach a run as two config layers:
 *  - the levels themselves, as the [agent] table (below a project's omnexx.toml and flags), and
 *  - what they imply for [plan], [context], budget and the output cap (derivedAgentLayer), just
 *    above the user's config.toml, so a project file or a CLI flag (`--for 8h`) still wins.
 */

type Plain = Record<string, unknown>;

export interface StoredAgentSettings {
  levels: AgentLevels | undefined;
  askOnStart: boolean;
}

export const agentSettingsFile = (p: OmnexxPaths): string =>
  join(p.configHome, 'agent-settings.json');

const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** The nearest allowed output cap. */
export function snapMaxTokens(n: number): number {
  return MAX_TOKEN_CHOICES.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best));
}

/** Levels from untrusted JSON: every field clamped, missing ones from the defaults. */
export function parseLevels(raw: unknown): AgentLevels {
  const o = isPlain(raw) ? raw : {};
  const level = (v: unknown, d: number): number => clampLevel(num(v) ?? d);
  const tokens = num(o.maxTokens);
  return {
    taskEffort: level(o.taskEffort, DEFAULT_LEVELS.taskEffort),
    turnEffort: level(o.turnEffort, DEFAULT_LEVELS.turnEffort),
    contextLevel: level(o.contextLevel, DEFAULT_LEVELS.contextLevel),
    time: isTimeChoice(o.time) ? o.time : DEFAULT_LEVELS.time,
    maxTokens: tokens === undefined ? DEFAULT_LEVELS.maxTokens : snapMaxTokens(tokens),
  };
}

export function parseAgentSettings(raw: unknown): StoredAgentSettings {
  const o = isPlain(raw) ? raw : {};
  return {
    levels: isPlain(o.levels) ? parseLevels(o.levels) : undefined,
    askOnStart: o.askOnStart !== false,
  };
}

export async function readAgentSettings(p: OmnexxPaths): Promise<StoredAgentSettings> {
  try {
    return parseAgentSettings(JSON.parse(await readFile(agentSettingsFile(p), 'utf8')));
  } catch {
    return { levels: undefined, askOnStart: true };
  }
}

export async function writeAgentSettings(
  p: OmnexxPaths,
  s: StoredAgentSettings,
): Promise<StoredAgentSettings> {
  const clean = parseAgentSettings(s);
  const file = agentSettingsFile(p);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

/** The saved levels as the [agent] table. */
export function agentSettingsLayer(s: StoredAgentSettings): Plain {
  const l = s.levels;
  return {
    agent: {
      ask_on_start: s.askOnStart,
      ...(l
        ? {
            task_effort: l.taskEffort,
            turn_effort: l.turnEffort,
            context_level: l.contextLevel,
            time: l.time,
            max_tokens_per_turn: l.maxTokens,
          }
        : {}),
    },
  };
}

/** The [agent] levels that are set, from a merged (raw or parsed) config. */
interface SetLevels {
  taskEffort?: number;
  turnEffort?: number;
  contextLevel?: number;
  time?: AgentLevels['time'];
  maxTokens?: number;
}

function setLevels(agentTable: unknown): SetLevels {
  const a = isPlain(agentTable) ? agentTable : {};
  const pick = (v: unknown): number | undefined => {
    const n = num(v);
    return n === undefined ? undefined : clampLevel(n);
  };
  const task = pick(a.task_effort);
  const turn = pick(a.turn_effort);
  const ctx = pick(a.context_level);
  const tokens = num(a.max_tokens_per_turn);
  return {
    ...(task === undefined ? {} : { taskEffort: task }),
    ...(turn === undefined ? {} : { turnEffort: turn }),
    ...(ctx === undefined ? {} : { contextLevel: ctx }),
    ...(isTimeChoice(a.time) ? { time: a.time } : {}),
    ...(tokens === undefined ? {} : { maxTokens: tokens }),
  };
}

/** The first worker model's context window, when a profile names it. */
function workerWindow(merged: Plain): number | undefined {
  const models = isPlain(merged.models) ? merged.models : {};
  const worker = models.worker;
  const ref = Array.isArray(worker) ? (worker[0] as unknown) : worker;
  const profiles = isPlain(models.profiles) ? models.profiles : {};
  const profile = typeof ref === 'string' ? profiles[ref] : undefined;
  return isPlain(profile) ? num(profile.context) : undefined;
}

/**
 * What the set levels imply for the rest of the config. `merged` is the config merged from every
 * layer (raw), so a level set anywhere counts. Undefined when no level is set.
 */
export function derivedAgentLayer(merged: Plain): Plain | undefined {
  const s = setLevels(merged.agent);
  const out: Plain = {};
  if (s.time) out.budget = { max_hours: timeHours(s.time) };
  if (s.taskEffort !== undefined) {
    const p = taskEffortProfile(s.taskEffort, s.time ? timeHours(s.time) : 0);
    out.plan = {
      mode: p.planMode,
      loop_think_turns: p.thinkTurns,
      loop_rounds: p.rounds,
      loop_rethinks: p.rethinks,
      ...(p.milestones === undefined ? {} : { milestones: p.milestones }),
    };
  }
  if (s.contextLevel !== undefined) {
    const c = contextProfile(s.contextLevel, workerWindow(merged));
    out.context = {
      compact_at: c.compactAt,
      clear_tool_results_at: c.clearAt,
      compact_keep_turns: c.keepTurns,
      keep_tool_results: c.keepToolResults,
      progress_tail: c.progressTail,
      notes_max_tokens: c.notesMaxTokens,
      repo_map_max_tokens: c.repoMapMaxTokens,
      ...(c.bare ? { sections: { codemap: 'hidden', lessons: 'optional', role: 'optional' } } : {}),
    };
  }
  if (s.maxTokens !== undefined) out.providers = { anthropic: { max_tokens: s.maxTokens } };
  return Object.keys(out).length ? out : undefined;
}

/** The levels a loaded config runs with, or undefined when none were set. */
export function levelsOf(config: { agent: unknown }): AgentLevels | undefined {
  const s = setLevels(config.agent);
  if (Object.keys(s).length === 0) return undefined;
  return { ...DEFAULT_LEVELS, ...s };
}

/** The settings brief for the agent's prompt, or undefined when no level is set. */
export function agentBriefFor(config: { agent: unknown }): string | undefined {
  const l = levelsOf(config);
  return l ? agentBrief(l) : undefined;
}

/** `{ brief }` for a context builder, or nothing when no level is set. */
export function briefInput(config: { agent: unknown }): { brief?: string } {
  const brief = agentBriefFor(config);
  return brief ? { brief } : {};
}

interface Layer {
  source: string;
  data: Plain;
}

/**
 * Add the agent layers to the config layers (highest precedence first; `userLast` when the
 * user's config.toml is the last one). Returns a new list.
 */
export function withAgentLayers(
  layers: readonly Layer[],
  stored: StoredAgentSettings,
  userLast: boolean,
  merge: (layers: readonly Layer[]) => Plain,
): Layer[] {
  const cut = userLast ? layers.length - 1 : layers.length;
  const withLevels = [
    ...layers.slice(0, cut),
    { source: 'your agent settings (agent-settings.json)', data: agentSettingsLayer(stored) },
    ...layers.slice(cut),
  ];
  const derived = derivedAgentLayer(merge(withLevels));
  if (!derived) return withLevels;
  return [
    ...withLevels.slice(0, cut + 1),
    { source: 'what your agent settings imply', data: derived },
    ...withLevels.slice(cut + 1),
  ];
}
