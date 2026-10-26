import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { parse as parseToml, stringify } from 'smol-toml';
import { resolvePaths, userConfigFile } from '../core/paths.js';
import { parseJsonc, serversFrom, type FoundServer } from '../integrations/importers.js';
import { SECRET_PREFIX, writeServerSecrets } from '../integrations/secrets.js';
import { readConfigText } from '../integrations/install.js';
import {
  mergeTableKeys,
  removeTable,
  setTable,
  type TomlValue,
} from '../integrations/toml-edit.js';
import { AMBER, CYAN, GREEN, MUTED, RED, VIOLET } from '../tui/colors.js';
import type { CommandRegistrar } from './commands/extra/types.js';
import { EXIT } from './exit-codes.js';
import { println, type CliIO } from './io.js';

/**
 * `omnexx migrate`: bring an existing claude-code / cursor setup into omnexx. Detects the other
 * tool's config (user-wide and for this project), plans what maps to omnexx's config (MCP
 * servers, model, env passthrough, denied commands, hooks), and applies it with the wizard
 * (`migratePrompt.tsx`) or non-interactively (`--yes` / `--json`).
 *
 * Both surfaces share the design tokens: the roles below are the same hex values the prompt uses
 * for its Ink colors, and the plain report paints with them too (design spec §3.3).
 */

export type AgentTool = 'claude-code' | 'cursor';
export type ToolScope = 'user' | 'project';

export interface MappedHook {
  on: 'pre_tool' | 'post_tool' | 'pre_commit';
  run: string;
  /** Glob over tool names; undefined = every tool. */
  match?: string;
}

/** What a `settings.json` (Claude Code or Cursor) contributes, once it is mapped. */
export interface ExternalAgentSettings {
  model?: string;
  /** Env var *names* set by the tool (`env` map keys); values are secrets and are not read. */
  envNames: string[];
  /** `permissions.deny` command patterns. */
  deny: string[];
  hooks: MappedHook[];
  /** Hooks in a shape omnexx has no equivalent for (shown in the report). */
  skippedHooks: number;
  /** Recognized-but-unmappable things (e.g. a model ref we can't name a provider for). */
  notes: string[];
  /** Unrecognized settings fields, preserved verbatim under `[raw.<tool>.<scope>]`. */
  raw?: Record<string, unknown>;
}

export interface AgentConfigDetection {
  tool: AgentTool;
  scope: ToolScope;
  detected: boolean;
  /** The config files/dirs that actually exist. */
  paths: string[];
  settings?: ExternalAgentSettings;
  servers: FoundServer[];
}

/** A server ready to be written as one `[mcp.servers.<name>]` table. */
export interface PlannedServer {
  name: string;
  source: FoundServer['source'];
  command?: string;
  args: string[];
  url?: string;
  /** Raw values; they become secrets, never config text. */
  env: Record<string, string>;
  headers: Record<string, string>;
}

export type MigrationItemKind = 'server' | 'model' | 'policy-env' | 'policy-deny' | 'hook' | 'raw';

export interface MigrationItem {
  id: string;
  tool: AgentTool;
  scope: ToolScope;
  kind: MigrationItemKind;
  /** The config file this item will be written to. */
  file: string;
  label: string;
  /** One line shown in the report and the wizard. */
  detail: string;
  server?: PlannedServer;
  modelRef?: string;
  envNames?: string[];
  deny?: string[];
  hook?: MappedHook;
  raw?: Record<string, unknown>;
}

export interface MigratePlan {
  detections: AgentConfigDetection[];
  items: MigrationItem[];
  /** Distinct target files (user config.toml, maybe the project's omnexx.toml). */
  files: string[];
}

// Design tokens (design spec §3): roles as shared hex values; the prompt uses them as Ink
// colors and the plain report as ANSI truecolor.
export const MIGRATE_ROLES = {
  ok: GREEN,
  warn: AMBER,
  bad: RED,
  info: CYAN,
  accent: CYAN,
  violet: VIOLET,
  muted: MUTED,
} as const;

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

async function readJson(file: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The paths among `candidates` that exist. */
const existing = async (candidates: readonly string[]): Promise<string[]> => {
  const hits = await Promise.all(
    candidates.map((p) => exists(p).then((ok) => (ok ? p : undefined))),
  );
  return hits.filter((p): p is string => p !== undefined);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Claude Code hook events that have an omnexx equivalent (the rest are counted and skipped). */
const CLAUDE_HOOK_EVENTS: Record<string, MappedHook['on']> = {
  PreToolUse: 'pre_tool',
  PostToolUse: 'post_tool',
  PreCommit: 'pre_commit',
};

function hookCommands(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  let n = 0;
  for (const e of v) {
    if (!isRecord(e)) continue;
    if (typeof e.command === 'string') n++;
    // Claude Code nests commands as { matchers, hooks: [{ command }] }.
    else if (Array.isArray(e.hooks)) n += hookCommands(e.hooks);
  }
  return n;
}

/** Claude Code hooks → omnexx `[[hooks]]` entries, best effort. */
function mapClaudeHooks(raw: unknown): { hooks: MappedHook[]; skippedHooks: number } {
  if (!isRecord(raw)) return { hooks: [], skippedHooks: 0 };
  const hooks: MappedHook[] = [];
  let skipped = 0;
  for (const [event, entries] of Object.entries(raw)) {
    const on = CLAUDE_HOOK_EVENTS[event];
    if (!on) {
      skipped += hookCommands(entries);
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) {
        skipped++;
        continue;
      }
      const patterns = (Array.isArray(entry.matchers) ? entry.matchers : [])
        .filter(isRecord)
        .map((m) => {
          const p = typeof m.pattern === 'string' ? m.pattern : m.toolName;
          return typeof p === 'string' && p !== '*' ? p : undefined;
        })
        .filter((p): p is string => p !== undefined);
      const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
      if (!inner.length) skipped++;
      for (const h of inner) {
        if (!isRecord(h) || typeof h.command !== 'string') {
          skipped++;
          continue;
        }
        const run = h.command.trim();
        if (!run) {
          skipped++;
          continue;
        }
        if (patterns.length) for (const p of patterns) hooks.push({ on, run, match: p });
        else hooks.push({ on, run });
      }
    }
  }
  return { hooks, skippedHooks: skipped };
}

function settingsFrom(raw: unknown): ExternalAgentSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined;
  const env = isRecord(raw.env) ? Object.keys(raw.env) : [];
  const perms = isRecord(raw.permissions) ? raw.permissions : {};
  const deny = strings(perms.deny);
  const { hooks, skippedHooks } = mapClaudeHooks(raw.hooks);
  const notes: string[] = [];
  if (model !== undefined && !toModelRef(model))
    notes.push(`model "${model}" (no known provider to attach it to)`);
  const out: ExternalAgentSettings = { envNames: env, deny, hooks, skippedHooks, notes };
  if (model !== undefined) out.model = model;
  const rawFields = unknownSettingsFields(raw);
  if (Object.keys(rawFields).length) out.raw = rawFields;
  return out;
}

/** Settings keys the migration consumes; every other field is preserved verbatim. */
const KNOWN_SETTINGS_KEYS = new Set(['model', 'env', 'permissions', 'hooks']);

/** Fields a config carries that omnexx has no mapping for, kept for round-tripping. */
function unknownSettingsFields(source: unknown): Record<string, unknown> {
  if (!isRecord(source)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (KNOWN_SETTINGS_KEYS.has(k)) continue;
    out[k] = v;
  }
  const perms = source.permissions;
  if (isRecord(perms)) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(perms)) if (k !== 'deny') rest[k] = v;
    if (Object.keys(rest).length) out.permissions = rest;
  }
  return out;
}

/** Map a tool's model string to an omnexx model ref, or undefined when the provider is unknown. */
export function toModelRef(model: string): string | undefined {
  const s = model.trim();
  if (!s) return undefined;
  // Already a `<provider>:<model>` ref (lowercase for consistency with omnexx refs).
  if (/^[a-z][a-z0-9_-]*:\S+$/.test(s)) return s.toLowerCase();
  // Claude Code / Cursor shorthand aliases.
  if (/^(opus|sonnet|haiku)$/i.test(s)) return `anthropic:${s.toLowerCase()}`;
  // Full Claude model ids: the Anthropic provider is the safe home for them.
  if (/^claude-\S+$/i.test(s)) return `anthropic:${s}`;
  return undefined;
}

function claudePaths(dir: string): { settings: string; json: string; mcp: string } {
  return {
    settings: join(dir, '.claude', 'settings.json'),
    json: join(dir, '.claude.json'),
    mcp: join(dir, '.mcp.json'),
  };
}

function cursorPaths(dir: string): { settings: string; mcp: string; rules: string } {
  return {
    settings: join(dir, '.cursor', 'settings.json'),
    mcp: join(dir, '.cursor', 'mcp.json'),
    rules: join(dir, '.cursor', 'rules'),
  };
}

/** Detect claude-code and cursor configs (user-wide and in this project). */
export async function detectAgentConfigs(io: CliIO): Promise<AgentConfigDetection[]> {
  const home = io.env.HOME ?? homedir();
  const repo = io.cwd;
  const out: AgentConfigDetection[] = [];

  // --- claude-code ---
  const cc = claudePaths(home);
  const ccProj = claudePaths(repo);
  const userJson = (await readJson(cc.json)) as
    { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | undefined;
  const projectMcp = await readJson(ccProj.mcp);
  const userSettings = await readJson(cc.settings);
  const projectSettings = await readJson(ccProj.settings);
  const userSettingsExists = (await exists(cc.settings)) || Boolean(userSettings);
  const userSettingsParsed = userSettingsExists ? settingsFrom(userSettings) : undefined;
  const userServerMap = (userJson as { mcpServers?: unknown } | undefined)?.mcpServers;
  const projectServerMap = userJson?.projects?.[resolve(repo)]?.mcpServers ?? projectMcp;
  const userPaths = await existing([cc.settings, cc.json]);
  out.push({
    tool: 'claude-code',
    scope: 'user',
    detected: userSettingsExists || Boolean(userServerMap),
    paths: userPaths,
    ...(userSettingsParsed ? { settings: userSettingsParsed } : {}),
    servers: serversFrom(userServerMap, 'Claude Code'),
  });
  const projectPaths = await existing([ccProj.settings, ccProj.mcp]);
  const projectSettingsParsed =
    projectSettings !== undefined ? settingsFrom(projectSettings) : undefined;
  out.push({
    tool: 'claude-code',
    scope: 'project',
    detected: projectPaths.length > 0 || Boolean(projectServerMap),
    paths: projectPaths,
    ...(projectSettingsParsed ? { settings: projectSettingsParsed } : {}),
    servers: serversFrom(projectServerMap, 'Claude Code (this project)'),
  });

  // --- cursor ---
  const cur = cursorPaths(home);
  const curProj = cursorPaths(repo);
  const userDir = await exists(join(home, '.cursor'));
  const userMcp = await readJson(cur.mcp);
  const userCursorSettings = await readJson(cur.settings);
  const projectDir = await exists(join(repo, '.cursor'));
  const cursorProjectMcp = await readJson(curProj.mcp);
  const projectCursorSettings = await readJson(curProj.settings);
  const userPaths2 = await existing([cur.settings, cur.mcp]);
  const userCursorParsed =
    userCursorSettings !== undefined ? settingsFrom(userCursorSettings) : undefined;
  out.push({
    tool: 'cursor',
    scope: 'user',
    detected: userDir && (userPaths2.length > 0 || Boolean(userMcp)),
    paths: userPaths2,
    ...(userCursorParsed ? { settings: userCursorParsed } : {}),
    servers: serversFrom(
      userMcp && isRecord(userMcp) ? (userMcp.mcpServers ?? userMcp.servers) : undefined,
      'Cursor',
    ),
  });
  const projectPaths2 = await existing([curProj.settings, curProj.mcp]);
  const rulesDir = projectDir && (await exists(curProj.rules));
  const projectCursorParsed =
    projectCursorSettings !== undefined ? settingsFrom(projectCursorSettings) : undefined;
  out.push({
    tool: 'cursor',
    scope: 'project',
    detected: projectPaths2.length > 0 || rulesDir || Boolean(cursorProjectMcp),
    paths: [...projectPaths2, ...(rulesDir ? [curProj.rules] : [])],
    ...(projectCursorParsed ? { settings: projectCursorParsed } : {}),
    servers: serversFrom(
      cursorProjectMcp && isRecord(cursorProjectMcp)
        ? (cursorProjectMcp.mcpServers ?? cursorProjectMcp.servers)
        : undefined,
      'Cursor (this project)',
    ),
  });

  return out;
}

/** Where a detection's items go: project config when it exists, else the user config. */
async function targetFile(io: CliIO, scope: ToolScope): Promise<string> {
  if (scope === 'project' && (await exists(join(io.cwd, 'omnexx.toml'))))
    return join(io.cwd, 'omnexx.toml');
  return userConfigFile(resolvePaths(io.env));
}

/** Build the migration plan from detections. Pure: nothing is read or written beyond detection. */
export async function planMigration(
  detections: readonly AgentConfigDetection[],
  io: CliIO,
  tools?: readonly string[],
): Promise<MigratePlan> {
  const wanted = new Set(tools?.length ? tools : ['claude-code', 'cursor']);
  const items: MigrationItem[] = [];
  const seenServers = new Set<string>();
  let seq = 0;

  const add = (item: Omit<MigrationItem, 'id'>): void => {
    items.push({ ...item, id: `${item.tool}:${item.scope}:${item.kind}:${seq++}` });
  };

  const files = new Set<string>();
  for (const d of detections) {
    if (!wanted.has(d.tool) || !d.detected) continue;
    const file = await targetFile(io, d.scope);
    files.add(file);
    for (const s of d.servers) {
      if (seenServers.has(s.name)) continue;
      seenServers.add(s.name);
      add({
        tool: d.tool,
        scope: d.scope,
        kind: 'server',
        file,
        label: `MCP server "${s.name}"`,
        detail: s.command ? `${s.command} ${s.args.join(' ')}`.trim() : (s.url ?? ''),
        server: {
          name: s.name,
          source: s.source,
          args: s.args,
          ...(s.command ? { command: s.command } : {}),
          ...(s.url ? { url: s.url } : {}),
          env: s.env,
          headers: s.headers,
        },
      });
    }
    if (d.settings) {
      const s = d.settings;
      if (s.model !== undefined) {
        const ref = toModelRef(s.model);
        if (ref)
          add({
            tool: d.tool,
            scope: d.scope,
            kind: 'model',
            file,
            label: `model ${s.model}`,
            detail: `worker = "${ref}"`,
            modelRef: ref,
          });
      }
      if (s.envNames.length)
        add({
          tool: d.tool,
          scope: d.scope,
          kind: 'policy-env',
          file,
          label: 'env passthrough',
          detail: s.envNames.join(', '),
          envNames: s.envNames,
        });
      if (s.deny.length)
        add({
          tool: d.tool,
          scope: d.scope,
          kind: 'policy-deny',
          file,
          label: 'permissions.deny',
          detail: s.deny.join(', '),
          deny: s.deny,
        });
      for (const h of s.hooks)
        add({
          tool: d.tool,
          scope: d.scope,
          kind: 'hook',
          file,
          label: `hook ${h.on}`,
          detail: h.run,
          hook: h,
        });
      if (s.raw && Object.keys(s.raw).length) {
        const n = Object.keys(s.raw).length;
        add({
          tool: d.tool,
          scope: d.scope,
          kind: 'raw',
          file,
          label: 'unrecognized settings',
          detail: `${n} field${n === 1 ? '' : 's'} preserved`,
          raw: s.raw,
        });
      }
    }
  }

  return {
    detections: [...detections],
    items,
    files: [...files],
  };
}

/**
 * A server's config table. Raw env/header values from the source config become entries in the
 * 0600 secrets file, referenced here by name (the same shape `omnexx mcp import` writes).
 */
function serverToml(s: PlannedServer): Record<string, TomlValue | undefined> {
  const env = Object.fromEntries(Object.keys(s.env).map((k) => [k, `${SECRET_PREFIX}${k}`]));
  const headers = Object.fromEntries(
    Object.keys(s.headers).map((h) => [h, `${SECRET_PREFIX}header:${h}`]),
  );
  return {
    command: s.command,
    args: s.command && s.args.length ? s.args : undefined,
    url: s.url,
    env: Object.keys(env).length ? env : undefined,
    headers_env: Object.keys(headers).length ? headers : undefined,
  };
}

/** Apply the plan (all items, or only the selected ids). Returns one result line per item. */
export async function applyMigration(
  plan: MigratePlan,
  io: CliIO,
  selectedIds?: readonly string[],
): Promise<string[]> {
  const selected = selectedIds ? new Set(selectedIds) : undefined;
  const items = plan.items.filter((i) => !selected || selected.has(i.id));
  const lines: string[] = [];
  const configHome = resolvePaths(io.env).configHome;

  // Group by file so each file is read/parsed/written once.
  const byFile = new Map<string, MigrationItem[]>();
  for (const item of items) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  for (const [file, group] of byFile) {
    let text = await readConfigText(file);
    let dirty = false;
    for (const item of group) {
      if (item.kind === 'server' && item.server) {
        const s = item.server;
        text = setTable(text, ['mcp', 'servers', s.name], serverToml(s));
        const envValues = { ...s.env };
        const headerValues = Object.fromEntries(
          Object.entries(s.headers).map(([k, v]) => [`header:${k}`, v]),
        );
        if (Object.keys(envValues).length || Object.keys(headerValues).length)
          await writeServerSecrets(configHome, s.name, { ...envValues, ...headerValues });
        dirty = true;
        lines.push(`${okGlyph()} MCP server "${s.name}" → ${file}`);
      } else if (item.kind === 'model' && item.modelRef) {
        text = mergeTableKeys(text, ['models'], { worker: item.modelRef });
        dirty = true;
        lines.push(`${okGlyph()} ${item.label} → [models] worker (${file})`);
      } else if (item.kind === 'policy-env' && item.envNames?.length) {
        text = mergePolicyArray(text, 'env_passthrough', item.envNames);
        dirty = true;
        lines.push(
          `${okGlyph()} ${item.envNames.length} env ${item.envNames.length === 1 ? 'name' : 'names'} → [policy] env_passthrough (${file})`,
        );
      } else if (item.kind === 'policy-deny' && item.deny?.length) {
        text = mergePolicyArray(text, 'deny', item.deny);
        dirty = true;
        lines.push(
          `${okGlyph()} ${item.deny.length} denied ${item.deny.length === 1 ? 'command' : 'commands'} → [policy] deny (${file})`,
        );
      } else if (item.kind === 'hook' && item.hook) {
        text = appendHooks(text, [item.hook]);
        dirty = true;
        lines.push(`${okGlyph()} ${item.label} → [[hooks]] (${file})`);
      } else if (item.kind === 'raw' && item.raw) {
        text = appendRawSection(text, item.tool, item.scope, item.raw);
        dirty = true;
        lines.push(`${okGlyph()} ${item.label} → [raw] (${file})`);
      }
    }
    if (dirty) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
    }
  }
  return lines;
}

function okGlyph(): string {
  return '✓';
}

/** Union a string array into a `[policy]` key (replacing is not enough: keep existing entries). */
function mergePolicyArray(text: string, keyName: string, values: readonly string[]): string {
  const parsed = parseToml(text) as { policy?: Record<string, unknown> };
  const existing = parsed.policy?.[keyName];
  const current = Array.isArray(existing) ? strings(existing) : [];
  const merged = [...current];
  for (const v of values) if (!merged.includes(v)) merged.push(v);
  return mergeTableKeys(text, ['policy'], { [keyName]: merged });
}

/** Append `[[hooks]]` tables, skipping ones that already exist (so re-running is idempotent). */
function appendHooks(text: string, hooks: readonly MappedHook[]): string {
  const parsed = parseToml(text) as { hooks?: unknown };
  const existing = Array.isArray(parsed.hooks)
    ? (parsed.hooks as { on?: unknown; run?: unknown; match?: unknown }[])
    : [];
  const fresh = hooks.filter(
    (h) =>
      !existing.some(
        (e) => e.on === h.on && e.run === h.run && (e.match === h.match || e.match === undefined),
      ),
  );
  if (!fresh.length) return text;
  const blocks = fresh.map((h) =>
    [
      '[[hooks]]',
      `on = ${JSON.stringify(h.on)}`,
      `run = ${JSON.stringify(h.run)}`,
      ...(h.match ? [`match = ${JSON.stringify(h.match)}`] : []),
    ].join('\n'),
  );
  const next = `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${blocks.join('\n\n')}\n`;
  parseToml(next); // validate before returning
  return next;
}

/** Write unrecognized fields under `[raw.<tool>.<scope>]`, replacing any prior copy. */
function appendRawSection(
  text: string,
  tool: AgentTool,
  scope: ToolScope,
  raw: Record<string, unknown>,
): string {
  const { text: cleared } = removeTable(text, ['raw', tool, scope]);
  const block = stringify({ raw: { [tool]: { [scope]: raw } } }).replace(/\s*$/, '');
  const next = `${cleared.replace(/\s*$/, '')}${cleared.trim() ? '\n\n' : ''}${block}\n`;
  parseToml(next); // validate before returning
  return next;
}

export interface MigrateOptions {
  json?: boolean;
  yes?: boolean;
  tool?: string[];
}

const paint =
  (io: CliIO, rgb: readonly [number, number, number], fallback: number) =>
  (s: string): string => {
    const on =
      (io.isTTY || Boolean(io.env.FORCE_COLOR)) && !io.env.NO_COLOR && io.env.TERM !== 'dumb';
    if (!on) return s;
    const truecolor = /truecolor|24bit/i.test(io.env.COLORTERM ?? '');
    const open = truecolor ? `38;2;${rgb.join(';')}` : String(fallback);
    return `\x1b[${open}m${s}\x1b[39m`;
  };

const ANSI_FALLBACK: Record<keyof typeof MIGRATE_ROLES, number> = {
  ok: 92,
  warn: 93,
  bad: 91,
  info: 96,
  accent: 96,
  violet: 95,
  muted: 90,
};

function role(io: CliIO, name: keyof typeof MIGRATE_ROLES): (s: string) => string {
  const hex = MIGRATE_ROLES[name];
  const rgb: [number, number, number] = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  return paint(io, rgb, ANSI_FALLBACK[name]);
}

/** The non-interactive report: same tokens as the wizard's screen, as ANSI text. */
export function renderMigrateReport(io: CliIO, plan: MigratePlan): void {
  const ok = role(io, 'ok');
  const muted = role(io, 'muted');
  const info = role(io, 'info');
  const violet = role(io, 'violet');
  const bad = role(io, 'bad');

  for (const d of plan.detections) {
    const head = `${d.tool}  ${d.scope}  `;
    if (!d.detected) {
      println(io.stdout, `${head}${muted('○ not detected')}`);
      continue;
    }
    println(io.stdout, `${head}${ok('✓ detected')}  ${muted(d.paths.join(', '))}`);
    const parts: string[] = [];
    const servers = d.servers.length
      ? violet(`${d.servers.length} server${d.servers.length === 1 ? '' : 's'}`)
      : '';
    if (servers) parts.push(servers);
    if (d.settings?.model && toModelRef(d.settings.model))
      parts.push(info(`model ${d.settings.model}`));
    if (d.settings?.envNames.length)
      parts.push(
        info(
          `${d.settings.envNames.length} env ${d.settings.envNames.length === 1 ? 'name' : 'names'}`,
        ),
      );
    if (d.settings?.deny.length) parts.push(info(`${d.settings.deny.length} denied`));
    if (d.settings?.hooks.length)
      parts.push(
        info(`${d.settings.hooks.length} hook${d.settings.hooks.length === 1 ? '' : 's'}`),
      );
    if (d.settings?.skippedHooks)
      parts.push(
        muted(`${d.settings.skippedHooks} hook${d.settings.skippedHooks === 1 ? '' : 's'} skipped`),
      );
    if (parts.length) println(io.stdout, `    · ${parts.join(' · ')}`);
    for (const n of d.settings?.notes ?? []) println(io.stdout, `    ${bad('✗')} ${muted(n)}`);
  }

  if (plan.items.length) {
    println(io.stdout, '');
    println(io.stdout, info('migrating:'));
    for (const item of plan.items) {
      const file = item.file;
      println(
        io.stdout,
        `  ${ok('+')} ${item.label.padEnd(30)} ${muted(item.detail.slice(0, 60))}  ${muted(`→ ${file}`)}`,
      );
    }
  }
}

function planToJson(plan: MigratePlan): unknown {
  return {
    detections: plan.detections.map((d) => ({
      tool: d.tool,
      scope: d.scope,
      detected: d.detected,
      paths: d.paths,
      model: d.settings?.model,
      env: d.settings?.envNames ?? [],
      deny: d.settings?.deny ?? [],
      hooks: d.settings?.hooks.length ?? 0,
      skippedHooks: d.settings?.skippedHooks ?? 0,
      notes: d.settings?.notes ?? [],
      servers: d.servers.map((s) => ({
        name: s.name,
        ...(s.command ? { command: s.command } : {}),
        args: s.args,
        ...(s.url ? { url: s.url } : {}),
      })),
    })),
    items: plan.items.map((i) => ({
      id: i.id,
      tool: i.tool,
      scope: i.scope,
      kind: i.kind,
      file: i.file,
      label: i.label,
      detail: i.detail,
    })),
  };
}

/** `omnexx migrate` entry point: wizard on a terminal, report / JSON / --yes otherwise. */
export async function runMigrate(io: CliIO, opts: MigrateOptions): Promise<number> {
  const detections = await detectAgentConfigs(io);
  const plan = await planMigration(detections, io, opts.tool);

  if (opts.json) {
    println(io.stdout, JSON.stringify(planToJson(plan), null, 2));
    return EXIT.ok;
  }
  if (opts.yes) {
    const lines = await applyMigration(plan, io);
    for (const l of lines) println(io.stdout, l);
    if (!lines.length) println(io.stdout, 'Nothing to migrate.');
    return EXIT.ok;
  }
  if (!io.isTTY) {
    renderMigrateReport(io, plan);
    println(io.stdout, '');
    println(
      io.stdout,
      'Run this on a terminal for the interactive wizard, or re-run with --yes to apply.',
    );
    return EXIT.ok;
  }

  const { showMigratePrompt } = await import('./migratePrompt.js');
  const outcome = await showMigratePrompt(plan, (ids) => applyMigration(plan, io, ids));
  for (const l of outcome.lines) println(io.stdout, l);
  return EXIT.ok;
}

export const register: CommandRegistrar = (
  program: Command,
  io: CliIO,
  setExit: (code: number) => void,
) => {
  const tools: string[] = [];
  program
    .command('migrate')
    .description('import your claude-code / cursor setup (MCP servers, model, permissions, hooks)')
    .option('--json', 'print the migration plan as JSON (no changes)')
    .option('-y, --yes', 'apply the whole plan without the interactive wizard')
    .option(
      '--tool <name>',
      'only this tool: claude-code | cursor (repeatable)',
      (v: string) => {
        tools.push(v);
        return tools;
      },
      tools,
    )
    .action(async (opts: { json?: boolean; yes?: boolean; tool?: string[] }) => {
      const filtered: MigrateOptions = { ...opts };
      if (!opts.tool?.length) delete filtered.tool;
      setExit(await runMigrate(io, filtered));
    });
};
