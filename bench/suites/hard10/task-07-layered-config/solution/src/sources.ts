import { readFileSync } from 'node:fs';
import { SCHEMA } from './schema.ts';
import { coerce } from './coerce.ts';
import { isObj } from './merge.ts';
import { leaves } from './paths.ts';

export interface Problem {
  path: string;
  message: string;
}

/** One layer: [path, value] pairs plus problems found while reading it. */
export interface Layer {
  values: [string, unknown][];
  problems: Problem[];
}

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const ENV_INDEX = new Map(
  Object.keys(SCHEMA).map((p) => [p.split('.').map(snake).join('__').toUpperCase(), p]),
);

export function fileLayer(file: string): Layer {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    return { values: [], problems: [{ path: file, message: (err as Error).message }] };
  }
  if (!isObj(data)) return { values: [], problems: [{ path: file, message: 'not a JSON object' }] };
  const all = leaves(data);
  return {
    values: all.filter(([p]) => p in SCHEMA),
    problems: all.filter(([p]) => !(p in SCHEMA)).map(([path]) => ({ path, message: 'unknown key' })),
  };
}

function coerced(path: string, raw: string, layer: Layer): Layer {
  const field = SCHEMA[path];
  if (!field) return { ...layer, problems: [...layer.problems, { path, message: 'unknown option' }] };
  const c = coerce(field, raw);
  return c.ok
    ? { ...layer, values: [...layer.values, [path, c.value]] }
    : { ...layer, problems: [...layer.problems, { path, message: c.message }] };
}

export function envLayer(env: Record<string, string | undefined>): Layer {
  let layer: Layer = { values: [], problems: [] };
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !name.toUpperCase().startsWith('APP_')) continue;
    const key = name.slice(4).toUpperCase();
    const path = ENV_INDEX.get(key) ?? key.toLowerCase().split('__').join('.');
    layer = coerced(path, raw, layer);
  }
  return layer;
}

export function argvLayer(argv: string[]): Layer {
  let layer: Layer = { values: [], problems: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      layer = coerced(body.slice(0, eq), body.slice(eq + 1), layer);
    } else if (body.startsWith('no-') && SCHEMA[body.slice(3)]?.type === 'boolean') {
      layer = { ...layer, values: [...layer.values, [body.slice(3), false]] };
    } else if (SCHEMA[body]?.type === 'boolean') {
      layer = { ...layer, values: [...layer.values, [body, true]] };
    } else {
      layer = { ...layer, problems: [...layer.problems, { path: body, message: 'unknown or non-boolean flag' }] };
    }
  }
  return layer;
}
