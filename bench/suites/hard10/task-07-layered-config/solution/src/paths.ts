import { isObj, type Obj } from './merge.ts';

export function setPath(obj: Obj, path: string, value: unknown): Obj {
  const [head, ...rest] = path.split('.');
  const key = head ?? '';
  if (!rest.length) return { ...obj, [key]: value };
  const child = isObj(obj[key]) ? obj[key] : {};
  return { ...obj, [key]: setPath(child, rest.join('.'), value) };
}

export function getPath(obj: Obj, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

/** Every leaf of `obj` as [dotted path, value]; arrays are leaves. */
export function leaves(obj: Obj, prefix = ''): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isObj(v) ? leaves(v, path) : [[path, v] as [string, unknown]];
  });
}
