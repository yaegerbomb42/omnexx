import { SCHEMA } from './schema.ts';
import { validate } from './coerce.ts';
import { argvLayer, envLayer, fileLayer, type Layer, type Problem } from './sources.ts';
import { setPath } from './paths.ts';
import type { Obj } from './merge.ts';

export interface LoadOptions {
  files?: string[];
  env?: Record<string, string | undefined>;
  argv?: string[];
}

export type LoadResult = { ok: true; config: Obj } | { ok: false; errors: Problem[] };

/** Defaults < files (in order) < env < argv, validated against SCHEMA. */
export function loadConfig(opts: LoadOptions = {}): LoadResult {
  const layers: Layer[] = [
    ...(opts.files ?? []).map(fileLayer),
    envLayer(opts.env ?? {}),
    argvLayer(opts.argv ?? []),
  ];
  const flat = new Map<string, unknown>(
    Object.entries(SCHEMA)
      .filter(([, f]) => f.default !== undefined)
      .map(([p, f]) => [p, f.default]),
  );
  for (const layer of layers) for (const [p, v] of layer.values) flat.set(p, v);
  const errors: Problem[] = layers.flatMap((l) => l.problems);
  for (const [path, field] of Object.entries(SCHEMA)) {
    if (!flat.has(path)) {
      if (field.required) errors.push({ path, message: 'required' });
      continue;
    }
    const problem = validate(field, flat.get(path));
    if (problem) errors.push({ path, message: problem });
  }
  if (errors.length) return { ok: false, errors };
  let config: Obj = {};
  for (const [p, v] of flat) config = setPath(config, p, v);
  return { ok: true, config };
}
