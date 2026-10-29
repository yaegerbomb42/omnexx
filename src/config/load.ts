import { readAgentSettings, withAgentLayers } from './agent-settings.js';
import { applyExecutionMode, isExecutionMode } from './execution.js';
import { readSectionModes, sectionsLayer } from './sections-file.js';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanRanked,
  parsePoolMode,
  rankingFile,
  rankingLayer,
  readPoolMode,
  readRanking,
} from './ranking.js';
import { parseRoles, readRoles, rolesFile, rolesLayer } from './roles.js';
import { upsertTomlTable } from './toml-file.js';
import { parse as parseToml, TomlError } from 'smol-toml';
import type { z } from 'zod';
import { ConfigError } from '../errors.js';
import { resolvePaths, userConfigFile, type OmnexxPaths } from '../core/paths.js';
import { configSchema, type ConfigInput, type OmnexxConfig } from './schema.js';

type Plain = Record<string, unknown>;

interface Layer {
  source: string;
  data: Plain;
}

export interface LoadConfigOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Already-shaped overrides from CLI flags (highest precedence). */
  flags?: ConfigInput;
  /** Skip the project file (e.g. `doctor` outside a repo still reads user config). */
  skipProject?: boolean;
}

export interface LoadedConfig {
  config: OmnexxConfig;
  /** Files that existed and were read, highest precedence first. */
  files: string[];
}

export const PROJECT_CONFIG = 'omnexx.toml';

type EnvKind = 'string' | 'number' | 'boolean';
/** Explicit env mapping. A generic OMNEXX_A_B_C scheme is ambiguous with snake_case keys. */
const ENV_MAP: readonly (readonly [string, readonly string[], EnvKind])[] = [
  ['OMNEXX_SANDBOX', ['sandbox'], 'string'],
  ['OMNEXX_BUDGET_MAX_USD', ['budget', 'max_usd'], 'number'],
  ['OMNEXX_BUDGET_MAX_USD_PER_DAY', ['budget', 'max_usd_per_day'], 'number'],
  ['OMNEXX_BUDGET_MAX_HOURS', ['budget', 'max_hours'], 'number'],
  ['OMNEXX_BUDGET_MAX_CYCLES', ['budget', 'max_cycles'], 'number'],
  ['OMNEXX_BUDGET_MAX_TURNS_PER_CYCLE', ['budget', 'max_turns_per_cycle'], 'number'],
  ['OMNEXX_MODELS_PLANNER', ['models', 'planner'], 'string'],
  ['OMNEXX_MODELS_WORKER', ['models', 'worker'], 'string'],
  ['OMNEXX_MODELS_CHEAP', ['models', 'cheap'], 'string'],
  ['OMNEXX_GIT_PUSH', ['git', 'push'], 'string'],
  ['OMNEXX_EXECUTION_MODE', ['execution', 'mode'], 'string'],
  ['OMNEXX_EXECUTION_DOMAIN', ['execution', 'domain'], 'string'],
  ['OMNEXX_EXPERIMENTAL', ['experimental'], 'boolean'],
  ['OMNEXX_JUDGE_KIND', ['judge', 'kind'], 'string'],
  ['OMNEXX_JUDGE_MODE', ['judge', 'mode'], 'string'],
  ['OMNEXX_JUDGE_NIMBLE_URL', ['judge', 'nimble', 'url'], 'string'],
  ['OMNEXX_NTFY_SERVER', ['notify', 'ntfy', 'server'], 'string'],
  ['OMNEXX_NTFY_TOPIC', ['notify', 'ntfy', 'topic'], 'string'],
  ['OMNEXX_TOOL_DISCOVERY', ['tools', 'discovery'], 'string'],
];

export const ENV_VARS = ENV_MAP.map(([name]) => name);

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function setPath(target: Plain, path: readonly string[], value: unknown): void {
  let node = target;
  path.forEach((key, i) => {
    if (i === path.length - 1) {
      node[key] = value;
      return;
    }
    const next = node[key];
    if (isPlain(next)) node = next;
    else {
      const created: Plain = {};
      node[key] = created;
      node = created;
    }
  });
}

/** Deep merge: plain objects merge key by key; arrays and scalars from `over` replace. */
export function deepMerge(base: Plain, over: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlain(prev) && isPlain(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

export function envLayer(env: NodeJS.ProcessEnv): Plain {
  const data: Plain = {};
  for (const [name, path, kind] of ENV_MAP) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    let value: unknown = raw;
    if (kind === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ConfigError(
          `${name}: expected a number, got "${raw}"`,
          `unset ${name} or fix it`,
        );
      }
    } else if (kind === 'boolean') {
      value = raw === '1' || raw.toLowerCase() === 'true';
    }
    setPath(data, path, value);
  }
  return data;
}

async function readTomlLayer(file: string): Promise<Layer | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return { source: file, data: parseToml(text) };
  } catch (err) {
    if (err instanceof TomlError) {
      throw new ConfigError(
        `${file}:${err.line}:${err.column}: ${err.message.split('\n')[0] ?? 'invalid TOML'}`,
        'fix the TOML syntax',
      );
    }
    throw err;
  }
}

function lookup(data: unknown, path: readonly PropertyKey[]): unknown {
  let node = data;
  for (const key of path) {
    if (!isPlain(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((k, i) => (typeof k === 'number' ? `[${k}]` : `${i === 0 ? '' : '.'}${String(k)}`))
    .join('');
}

/** Turn the first zod issue into one actionable line that names the source of the bad value. */
export function formatConfigIssue(issue: z.core.$ZodIssue, layers: readonly Layer[]): ConfigError {
  const path = issue.path;
  // Unknown-key issues point at the parent; append the key so the user sees the exact name.
  const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
  const shownPath = formatPath(keys.length ? [...path, keys[0] ?? ''] : path);
  const probe = keys.length ? [...path, keys[0] ?? ''] : path;
  const layer = layers.find((l) => lookup(l.data, probe) !== undefined);
  const where = layer ? layer.source : 'defaults';
  const what =
    issue.code === 'unrecognized_keys'
      ? `unknown key${keys.length > 1 ? 's' : ''} ${keys.map((k) => `"${k}"`).join(', ')}`
      : issue.message;
  return new ConfigError(
    `config error in ${where}: ${shownPath || '(root)'}: ${what}`,
    'see docs/config.md for every key and its default',
  );
}

/**
 * Fold the legacy roles.json / models.json into the unified config.toml ([roles] / [pool])
 * and rename the old files to *.migrated. A key already in config.toml wins and the old
 * file is still renamed (the new file is the source of truth). Key rotation is untouched:
 * migration only appends [roles] / [pool] tables and never rewrites [providers.endpoints].
 * Never throws: a missing or unreadable legacy file is simply left alone.
 */
async function migrateLegacyFiles(paths: OmnexxPaths, userData: Plain | undefined): Promise<void> {
  const configFile = userConfigFile(paths);
  try {
    const parsed = parseRoles(JSON.parse(await readFile(rolesFile(paths), 'utf8')));
    const hasAny =
      Object.keys(parsed.models).length > 0 ||
      Object.keys(parsed.strategies).length > 0 ||
      !parsed.spreadHelpers;
    if (hasAny && userData?.roles === undefined) {
      await upsertTomlTable(configFile, 'roles', {
        spread_helpers: parsed.spreadHelpers,
        models: parsed.models,
        strategies: parsed.strategies,
      });
    }
    await rename(rolesFile(paths), `${rolesFile(paths)}.migrated`).catch(() => undefined);
  } catch {
    // No legacy roles file, or one that cannot be read: nothing to migrate.
  }
  try {
    const parsed = JSON.parse(await readFile(rankingFile(paths), 'utf8')) as {
      ranked?: unknown;
      mode?: unknown;
    };
    const ranked = cleanRanked(parsed.ranked);
    if (ranked.length && userData?.pool === undefined) {
      await upsertTomlTable(configFile, 'pool', {
        ranked,
        mode: parsePoolMode(parsed.mode),
      });
    }
    await rename(rankingFile(paths), `${rankingFile(paths)}.migrated`).catch(() => undefined);
  } catch {
    // No legacy ranking file, or one that cannot be read: nothing to migrate.
  }
}

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);

  // Highest precedence first, which is also the order used to attribute a bad value.
  const layers: Layer[] = [];
  if (opts.flags) layers.push({ source: 'command-line flags', data: opts.flags });
  layers.push({ source: 'OMNEXX_* environment', data: envLayer(env) });
  const project = opts.skipProject
    ? undefined
    : await readTomlLayer(join(opts.cwd, PROJECT_CONFIG));
  if (project) layers.push(project);
  // Context sections set in the editor's Context explorer: same place as roles.
  const sections = sectionsLayer(await readSectionModes(paths));
  if (sections)
    layers.push({ source: 'your context sections (context-sections.json)', data: sections });
  const user = await readTomlLayer(userConfigFile(paths));
  // One-time move: roles.json / models.json fold into the unified config.toml ([roles] /
  // [pool]) and the old files are renamed to *.migrated. Keys already in config.toml win;
  // an unreadable legacy file never blocks startup. The readers still understand the old
  // files, so restoring one re-migrates it on the next start.
  await migrateLegacyFiles(paths, user?.data);
  // Roles chosen in the editor: above the /models pool, below a project's omnexx.toml and flags.
  const roles = rolesLayer(await readRoles(paths));
  if (roles) layers.push({ source: 'your model roles', data: roles });
  // /models ranking: above your config.toml, below a project's omnexx.toml and flags.
  const poolMode = await readPoolMode(paths);
  const ranked = rankingLayer(await readRanking(paths), poolMode);
  if (ranked) layers.push({ source: 'your /models ranking', data: ranked });
  // The `model` key is the default for every role: it fills the roles the [models] table
  // and the pool leave unset, so first run only has to ask for one model.
  let userLayer = user;
  const defaultModel = typeof user?.data.model === 'string' ? user.data.model : undefined;
  if (user && defaultModel) {
    const fill: Plain = {
      models: {
        chat: [defaultModel],
        planner: [defaultModel],
        worker: [defaultModel],
        cheap: [defaultModel],
      },
    };
    userLayer = { ...user, data: deepMerge(fill, user.data) };
  }
  if (userLayer) layers.push(userLayer);
  const mergeLayers = (ls: readonly Layer[]): Plain =>
    [...ls].reverse().reduce<Plain>((acc, l) => deepMerge(acc, l.data), {});
  // The agent sliders (/settings): the levels, and what they imply for plan/context/budget.
  let all = withAgentLayers(layers, await readAgentSettings(paths), Boolean(user), mergeLayers);
  // Execution modes: a preset that fills plan/loop keys the user did not set. It is the
  // lowest-precedence layer, so any explicit value anywhere wins; "normal" adds nothing.
  const rawMode = (mergeLayers(all).execution as Plain | undefined)?.mode;
  const mode = typeof rawMode === 'string' && isExecutionMode(rawMode) ? rawMode : 'normal';
  if (mode !== 'normal') {
    all = [...all, { source: `execution mode preset (${mode})`, data: applyExecutionMode(mode) }];
  }

  const merged = mergeLayers(all);
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (!first) throw new ConfigError('invalid configuration');
    throw formatConfigIssue(first, all);
  }
  // Smart pool: Nimble picks the model per action. With no judge set up, borrow Nimble for
  // routing only; when Nimble isn't running the router falls back to the pool order.
  if (poolMode === 'smart' && ranked) {
    if (parsed.data.judge.kind === 'none') {
      parsed.data.judge.kind = 'nimble';
      parsed.data.judge.uses = ['route'];
    }
    if (parsed.data.router.kind === 'rules') parsed.data.router.kind = 'auto';
  }
  return {
    config: parsed.data,
    files: [project?.source, user?.source].filter((f): f is string => f !== undefined),
  };
}

/** Defaults only, for code paths and tests that need a full config without any files. */
export function defaultConfig(overrides: ConfigInput = {}): OmnexxConfig {
  return configSchema.parse(overrides);
}
