import { Box, Text } from 'ink';
import { findProviderKey } from '../auth/keys.js';
import type { CliIO } from '../cli/io.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths } from '../core/paths.js';
import { discoverModels } from '../providers/discovery.js';
import { envKeys } from '../cli/connect.js';
import { nextPoolMode, POOL_MODES, type PoolMode } from '../config/ranking.js';
import { STRATEGY_HINT, STRATEGY_LABEL } from '../config/routing.js';
import { CYAN, GRAY, GREEN } from './colors.js';

export type PickerItem =
  | { kind: 'model'; ref: string; provider: string; model: string }
  | { kind: 'add-key'; label: string }
  | { kind: 'add-env'; label: string }
  | { kind: 'add-url'; label: string };

export interface ModelPickerState {
  items: PickerItem[];
  query: string;
  cursor: number;
  current: string | undefined;
  /** Picking for the pool: tab ticks several models, enter adds them all. */
  checked?: Set<string>;
  /** Providers whose model list couldn't be fetched (server down, bad key). */
  unreachable: string[];
}

const ADD: PickerItem[] = [
  {
    kind: 'add-key',
    label: '+ paste an API key (OpenAI, OpenRouter, Groq, Gemini, xAI, Anthropic…)',
  },
  { kind: 'add-url', label: '+ add a custom endpoint (any OpenAI-compatible URL)' },
];

/** Built-in Anthropic aliases, offered when a key is set. */
const ANTHROPIC = ['opus', 'sonnet', 'haiku'];

/**
 * Every model the person can chat with right now: Anthropic's (with a key) and each configured
 * endpoint's `/models` list (endpoints with a key or marked free), fetched in parallel.
 */
export async function loadModelChoices(
  io: CliIO,
): Promise<{ items: PickerItem[]; unreachable: string[] }> {
  const paths = resolvePaths(io.env);
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const items: PickerItem[] = [];
  if (await findProviderKey(paths, io.env, 'anthropic'))
    for (const m of ANTHROPIC)
      items.push({ kind: 'model', ref: `anthropic:${m}`, provider: 'anthropic', model: m });
  const unreachable: string[] = [];
  const lists = await Promise.all(
    Object.entries(config.providers.endpoints).map(async ([name, ep]) => {
      const apiKey = (await findProviderKey(paths, io.env, name, ep.api_key_env))?.key;
      if (!apiKey && !ep.free) return [name, undefined] as const;
      const models = await discoverModels(
        { baseUrl: ep.base_url, ...(apiKey ? { apiKey } : {}) },
        { timeoutMs: 3_000, ...(io.fetch ? { fetch: io.fetch } : {}) },
      );
      return [name, models.map((m) => m.id)] as const;
    }),
  );
  for (const [name, ids] of lists) {
    if (!ids?.length) {
      unreachable.push(name);
      continue;
    }
    for (const id of ids)
      items.push({ kind: 'model', ref: `${name}:${id}`, provider: name, model: id });
  }
  const env = await envKeys(io).catch(() => []);
  const fromEnv: PickerItem[] = env.length
    ? [
        {
          kind: 'add-env',
          label: `+ use the keys in your environment (${env.map((k) => k.label).join(', ')})`,
        },
      ]
    : [];
  return { items: [...items, ...fromEnv, ...ADD], unreachable };
}

/** Items matching the typed query (every word must appear); the add actions always stay. */
export function filterChoices(items: readonly PickerItem[], query: string): PickerItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter(
    (it) => it.kind !== 'model' || words.every((w) => it.ref.toLowerCase().includes(w)),
  );
}

const VISIBLE = 12;

export function ModelPicker({ state, width }: { state: ModelPickerState; width: number }) {
  const shown = filterChoices(state.items, state.query);
  const cursor = Math.min(state.cursor, Math.max(0, shown.length - 1));
  const start = Math.max(0, Math.min(cursor - Math.floor(VISIBLE / 2), shown.length - VISIBLE));
  const page = shown.slice(start, start + VISIBLE);
  const models = shown.filter((i) => i.kind === 'model').length;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={GREEN} paddingX={1} width={width}>
      <Text>
        <Text color={GREEN} bold>
          choose a model
        </Text>
        <Text
          color={GRAY}
        >{`  ${models} match${models === 1 ? '' : 'es'} · type to filter · ↑↓ ·${state.checked ? ` tab tick (${state.checked.size}) · enter add ticked ·` : ' enter ·'} esc`}</Text>
      </Text>
      <Text>
        <Text color={GRAY}>{'filter: '}</Text>
        <Text>{state.query}</Text>
        <Text color={GREEN}>█</Text>
      </Text>
      {page.map((it, i) => {
        const at = start + i === cursor;
        const box =
          state.checked && it.kind === 'model' ? (state.checked.has(it.ref) ? '[x] ' : '[ ] ') : '';
        const label =
          it.kind === 'model'
            ? `${box}${it.ref}${it.ref === state.current ? '  (current)' : ''}`
            : it.label;
        return (
          <Text key={it.kind === 'model' ? it.ref : it.kind} inverse={at} wrap="truncate-end">
            <Text {...(at ? {} : { color: it.kind === 'model' ? CYAN : GREEN })}>{label}</Text>
          </Text>
        );
      })}
      {shown.length > VISIBLE && (
        <Text color={GRAY}>{`  … ${shown.length - VISIBLE} more, keep typing to narrow`}</Text>
      )}
      {state.unreachable.length > 0 && (
        <Text color={GRAY}>{`not reachable right now: ${state.unreachable.join(', ')}`}</Text>
      )}
    </Box>
  );
}

export interface RankState {
  ranked: string[];
  mode: PoolMode;
  /** Refs out of quota right now (skipped until their quota resets). */
  exhausted: Set<string>;
  cursor: number;
  /** Space picked the row up: ↑↓ move it instead of the cursor. */
  grabbed: boolean;
}

/** What a key does in the /models list (adding and closing are the session's job). */
export type RankKey = 'up' | 'down' | 'move-up' | 'move-down' | 'grab' | 'remove' | 'mode';

/** Move the item at `from` to `to`, returning a new list. */
export function moveItem<T>(xs: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= xs.length || to < 0 || to >= xs.length) return [...xs];
  const out = xs.filter((_, i) => i !== from);
  const it = xs[from] as T;
  return [...out.slice(0, to), it, ...out.slice(to)];
}

/** The /models list after one key, as a new state. */
export function rankReduce(s: RankState, key: RankKey): RankState {
  const last = s.ranked.length - 1;
  const step = (d: number): RankState => {
    const to = s.cursor + d;
    if (to < 0 || to > last) return s;
    const carry = s.grabbed || key === 'move-up' || key === 'move-down';
    return { ...s, cursor: to, ranked: carry ? moveItem(s.ranked, s.cursor, to) : s.ranked };
  };
  switch (key) {
    case 'up':
    case 'move-up':
      return step(-1);
    case 'down':
    case 'move-down':
      return step(1);
    case 'grab':
      return { ...s, grabbed: !s.grabbed && s.ranked.length > 0 };
    case 'remove': {
      const ranked = s.ranked.filter((_, i) => i !== s.cursor);
      const cursor = Math.max(0, Math.min(s.cursor, ranked.length - 1));
      return { ...s, ranked, grabbed: false, cursor };
    }
    case 'mode':
      return { ...s, mode: nextPoolMode(s.mode) };
  }
}

/** What a row says next to its rank, given the mode. */
export function rankNote(mode: PoolMode, i: number, out: boolean): string {
  if (out) return 'out of quota, skipped until it resets';
  if (mode === 'random') return 'picked at random';
  if (i === 0) return mode === 'priority' ? 'tried first every call' : 'used until it runs out';
  return i === 1 ? 'first fallback' : 'next fallback';
}

const modeLine = (mode: PoolMode): string =>
  mode === 'smart'
    ? 'Smart: a local model picks per action (press m for the main modes)'
    : `${STRATEGY_LABEL[mode]}: ${STRATEGY_HINT[mode]}`;

/** /models: the ranked provider:model list every role uses, and how it is used. */
export function RankEditor({ state, width }: { state: RankState; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={GREEN} paddingX={1} width={width}>
      <Text>
        <Text color={GREEN} bold>
          your models, ranked
        </Text>
        <Text color={GRAY}>
          {'  ↑↓ select · shift+↑↓ or space move · a add · x remove · m mode · esc done'}
        </Text>
      </Text>
      <Text>
        {POOL_MODES.map((m) =>
          m === state.mode ? (
            <Text key={m} color={CYAN} bold>{`[${STRATEGY_LABEL[m]}] `}</Text>
          ) : (
            <Text key={m} color={GRAY}>{` ${STRATEGY_LABEL[m]}  `}</Text>
          ),
        )}
      </Text>
      <Text color={GRAY}>{modeLine(state.mode)}</Text>
      {state.ranked.length === 0 && (
        <Text color={GRAY}>
          empty: roles use your config.toml models. press a to add your best model first.
        </Text>
      )}
      {state.ranked.map((ref, i) => (
        <Text key={ref} inverse={i === state.cursor} wrap="truncate-end">
          <Text color={i === state.cursor && state.grabbed ? CYAN : GREEN}>
            {`${i + 1}. ${i === state.cursor && state.grabbed ? '⇕ ' : ''}${ref}`}
          </Text>
          <Text color={GRAY}>{`  ${rankNote(state.mode, i, state.exhausted.has(ref))}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
