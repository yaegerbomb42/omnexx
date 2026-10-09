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

/** Remove a table and its sub-tables (`[a.b]`, `[a.b.c]`); comments and other tables stay. */
export function removeTable(
  raw: string,
  path: readonly string[],
): { text: string; removed: boolean } {
  const target = path.join('\u0000');
  const lines = raw.split('\n');
  const out: string[] = [];
  let skipping = false;
  let removed = false;
  for (const line of lines) {
    const h = headerPath(line);
    if (h !== undefined) skipping = h === target || h.startsWith(`${target}\u0000`);
    if (skipping) {
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
