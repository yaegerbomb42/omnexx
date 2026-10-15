import { readFileSync } from 'node:fs';
import { SCHEMA } from './schema.ts';
import { merge, type Obj } from './merge.ts';

/** Defaults, then one JSON file. Throws on the first problem. */
export function loadConfig(file: string): Obj {
  let config: Obj = {};
  for (const [path, field] of Object.entries(SCHEMA)) {
    if (field.default !== undefined) config = setPath(config, path, field.default);
  }
  const data = JSON.parse(readFileSync(file, 'utf-8')) as Obj;
  config = merge(config, data);
  for (const [path, field] of Object.entries(SCHEMA)) {
    if (field.required && getPath(config, path) === undefined) throw new Error(`${path} is required`);
  }
  return config;
}

function setPath(obj: Obj, path: string, value: unknown): Obj {
  const [head, ...rest] = path.split('.');
  const key = head ?? '';
  if (!rest.length) return { ...obj, [key]: value };
  const child = (obj[key] as Obj | undefined) ?? {};
  return { ...obj, [key]: setPath(child, rest.join('.'), value) };
}

function getPath(obj: Obj, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Obj | undefined)?.[k], obj);
}
