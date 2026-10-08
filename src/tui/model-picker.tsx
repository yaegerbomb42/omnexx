import { Box, Text } from 'ink';
import { findProviderKey } from '../auth/keys.js';
import type { CliIO } from '../cli/io.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths } from '../core/paths.js';
import { discoverModels } from '../providers/discovery.js';
import { envKeys } from '../cli/connect.js';
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
        >{`  ${models} match${models === 1 ? '' : 'es'} · type to filter · ↑↓ · enter · esc`}</Text>
      </Text>
      <Text>
        <Text color={GRAY}>{'filter: '}</Text>
        <Text>{state.query}</Text>
        <Text color={GREEN}>█</Text>
      </Text>
      {page.map((it, i) => {
        const at = start + i === cursor;
        const label =
          it.kind === 'model'
            ? `${it.ref}${it.ref === state.current ? '  (current)' : ''}`
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
  cursor: number;
  /** Space picked the row up: ↑↓ move it instead of the cursor. */
  grabbed: boolean;
}

const ROLE_HINT = [
  'chat, planner, worker and helpers try this first',
  'first fallback',
  'next fallback',
];

/** /models: the ranked provider:model list every role falls back through, top first. */
export function RankEditor({ state, width }: { state: RankState; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={GREEN} paddingX={1} width={width}>
      <Text>
        <Text color={GREEN} bold>
          your model ranking
        </Text>
        <Text color={GRAY}>{'  ↑↓ move · space pick up/drop · a add · x remove · esc done'}</Text>
      </Text>
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
          <Text color={GRAY}>{`  ${ROLE_HINT[i] ?? 'fallback'}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
