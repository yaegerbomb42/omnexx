import { parse } from 'smol-toml';

/**
 * Edit one table of a TOML file as text, so everything else (comments, order, blank lines) stays
 * exactly as the person wrote it. Re-serializing the parsed file would drop every comment.
 */

export type TomlValue =
  string | number | boolean | readonly string[] | Readonly<Record<string, string>>;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function key(k: string): string {
  return BARE_KEY.test(k) ? k : JSON.stringify(k);
}

/** A value as one TOML line's right-hand side. JSON strings are valid TOML basic strings. */
function value(v: TomlValue): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v))
    return `[${(v as readonly string[]).map((x) => JSON.stringify(x)).join(', ')}]`;
  const entries = Object.entries(v as Record<string, string>);
  return entries.length
    ? `{ ${entries.map(([k, x]) => `${key(k)} = ${JSON.stringify(x)}`).join(', ')} }`
    : '{}';
}

/** `mcp.servers.my-server` → `[mcp.servers.my-server]`, quoting segments that need it. */
export function tableHeader(path: readonly string[]): string {
  return `[${path.map(key).join('.')}]`;
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const KEY_VALUE = /^\s*([A-Za-z0-9_.-]+)\s*=/;

/** The normalized dotted path of a header line, or undefined when the line isn't one. */
function headerPath(line: string): string | undefined {
  const m = HEADER.exec(line);
  if (!m?.[1]) return undefined;
  const parsed = parse(
    `${line.trim().startsWith('[[') ? '[[' : '['}${m[1]}${line.trim().startsWith('[[') ? ']]' : ']'}\n`,
  );
  const parts: string[] = [];
  let cur: unknown = parsed;
  while (cur && typeof cur === 'object') {
    const ks = Object.keys(cur);
    if (ks.length !== 1 || ks[0] === undefined) break;
    parts.push(ks[0]);
    cur = (cur as Record<string, unknown>)[ks[0]];
    if (Array.isArray(cur)) cur = cur[0];
  }
  return parts.join('\u0000');
}

/** Extract full key path for a line given the current header path. */
function lineKeyPath(line: string, currentHeader: string): string | undefined {
  const m = KEY_VALUE.exec(line);
  if (!m?.[1]) return undefined;
  const keyParts = m[1].split('.');
  const prefix = currentHeader ? `${currentHeader}\u0000` : '';
  return `${prefix}${keyParts.join('\u0000')}`;
}

/** Remove a table and its sub-tables (`[a.b]`, `[a.b.c]`); comments and other tables stay. */
export function removeTable(
  raw: string,
  path: readonly string[],
): { text: string; removed: boolean } {
  const target = path.join('\u0000');
  const targetPrefix = `${target}\u0000`;
  const lines = raw.split('\n');
  const out: string[] = [];
  let currentHeader = '';
  let skippingHeader = false;
  let removed = false;

  for (const line of lines) {
    const h = headerPath(line);
    if (h !== undefined) {
      currentHeader = h;
      skippingHeader = h === target || h.startsWith(targetPrefix);
    }

    if (skippingHeader) {
      removed = true;
      continue;
    }

    const kp = lineKeyPath(line, currentHeader);
    if (kp !== undefined && (kp === target || kp.startsWith(targetPrefix))) {
      removed = true;
      continue;
    }

    out.push(line);
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text, removed };
}

/**
 * Replace (or add) one table with these keys. The new table goes at the end of the file. The
 * result is parsed before it's returned, so a bad edit throws instead of breaking the config.
 */
export function setTable(
  raw: string,
  path: readonly string[],
  values: Readonly<Record<string, TomlValue | undefined>>,
): string {
  const { text } = removeTable(raw, path);
  const body = Object.entries(values)
    .filter((e): e is [string, TomlValue] => e[1] !== undefined)
    .map(([k, v]) => `${key(k)} = ${value(v)}`);
  const next = `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${tableHeader(path)}\n${body.join('\n')}\n`;
  parse(next);
  return next;
}

/** The line range of a table's body: [after its header, next sibling header). Undefined when absent. */
function tableBody(raw: string, path: readonly string[]): [number, number] | undefined {
  const target = path.join('\u0000');
  const lines = raw.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerPath(lines[i] ?? '') === target) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const h = headerPath(lines[i] ?? '');
    if (h !== undefined && h !== target && !h.startsWith(`${target}\u0000`)) {
      end = i;
      break;
    }
  }
  return [start, end];
}

/** Whether `line` starts a `key = …` statement (not a comment or a table header). */
function hasKey(line: string, name: string): boolean {
  const trimmed = line.trimStart();
  return (
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('[') &&
    new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(trimmed)
  );
}

/** How many lines a `key = …` statement spans, so replacements cover multiline arrays/tables. */
function statementSpan(lines: readonly string[], start: number, end: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < end; i++) {
    let seen = false;
    for (const ch of lines[i] ?? '') {
      if (inString) {
        if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth++;
        seen = true;
      } else if (ch === ']') {
        depth--;
        seen = true;
      } else if (!/\s/.test(ch)) {
        seen = true;
      }
    }
    if (depth <= 0 && seen && !inString) return i - start + 1;
  }
  return end - start;
}

/**
 * Add or replace keys inside an existing table, leaving its comments, ordering and other keys
 * alone (unlike setTable, which would replace the whole table). Array values replace whatever was
 * there; callers merge when they want a union. When the table is missing, it is appended. The
 * result is parsed before it's returned, so a bad edit throws instead of breaking the config.
 */
export function mergeTableKeys(
  raw: string,
  path: readonly string[],
  values: Readonly<Record<string, TomlValue | undefined>>,
): string {
  const body = tableBody(raw, path);
  if (!body) return setTable(raw, path, values);
  const [start, end] = body;
  const lines = raw.split('\n');
  const inserts: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const name = key(k);
    const line = `${name} = ${value(v)}`;
    let replaced = false;
    for (let i = start; i < end; i++) {
      if (hasKey(lines[i] ?? '', name)) {
        lines.splice(i, statementSpan(lines, i, end), line);
        replaced = true;
        break;
      }
    }
    if (!replaced) inserts.push(line);
  }
  if (inserts.length) lines.splice(start, 0, ...inserts);
  const next = lines.join('\n');
  parse(next);
  return next;
}
