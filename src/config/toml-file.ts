import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';

/**
 * Surgical edits to a TOML file that keep everything else byte-for-byte: comments, key
 * order and unrelated tables survive. The unified user config (config.toml) is edited this
 * way by the /models editor and by migration, so a person's hand-written file is never
 * reformatted out from under them.
 */

/** Serialize read-modify-write per file so concurrent writers don't clobber each other. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(file: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(file) ?? Promise.resolve();
  const run = prior.then(work, work);
  queues.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function isTableHeader(line: string): string | undefined {
  const m = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
  return m ? m[1]?.trim() : undefined;
}

/**
 * Replace (or append) one whole `[table]` block — the table and its dotted subtables
 * (`[roles.models]`, …) — with `body` serialized as that table. Creates the file when missing.
 */
export async function upsertTomlTable(
  file: string,
  table: string,
  body: Record<string, unknown>,
): Promise<void> {
  return enqueue(file, () => upsertTomlTableInner(file, table, body));
}

async function upsertTomlTableInner(
  file: string,
  table: string,
  body: Record<string, unknown>,
): Promise<void> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const block = stringifyToml({ [table]: body }).trimEnd();
  const lines = text === '' ? [] : text.split('\n');
  const out: string[] = [];
  let i = 0;
  let replaced = false;
  while (i < lines.length) {
    const header = isTableHeader(lines[i] ?? '');
    if (header === table) {
      // Skip the old block: this table and its dotted subtables, up to the next table.
      replaced = true;
      i++;
      while (i < lines.length) {
        const next = isTableHeader(lines[i] ?? '');
        if (next !== undefined && next !== table && !next.startsWith(`${table}.`)) break;
        i++;
      }
      out.push(block);
      continue;
    }
    out.push(lines[i] ?? '');
    i++;
  }
  if (!replaced) {
    if (out.length && (out[out.length - 1] ?? '').trim() !== '') out.push('');
    out.push(block);
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, out.join('\n').replace(/\n+$/, '\n'));
}

function tomlValue(value: string | boolean | number): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Replace (or insert) top-level `key = value` lines, before the first table header. Only
 * for scalar keys (provider, model, experimental): arrays and tables use upsertTomlTable.
 */
export async function upsertTomlKeys(
  file: string,
  keys: Record<string, string | boolean | number>,
): Promise<void> {
  return enqueue(file, () => upsertTomlKeysInner(file, keys));
}

async function upsertTomlKeysInner(
  file: string,
  keys: Record<string, string | boolean | number>,
): Promise<void> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = text === '' ? [] : text.split('\n');
  const pending = new Map(Object.entries(keys));
  // The top-level region ends at the first table header.
  let firstTable = lines.findIndex((l) => isTableHeader(l) !== undefined);
  if (firstTable === -1) firstTable = lines.length;
  const out = [...lines];
  for (let i = 0; i < firstTable; i++) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(out[i] ?? '');
    const key = m?.[1];
    if (key && pending.has(key)) {
      out[i] = `${key} = ${tomlValue(pending.get(key) as string | boolean | number)}`;
      pending.delete(key);
    }
  }
  if (pending.size) {
    const insert = [...pending.entries()].map(([k, v]) => `${k} = ${tomlValue(v)}`);
    out.splice(firstTable, 0, ...insert);
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, out.join('\n').replace(/\n+$/, '\n'));
}
