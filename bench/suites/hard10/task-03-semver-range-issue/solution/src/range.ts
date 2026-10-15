import { compareParsed, parse, type SemVer } from './version.ts';

type Op = '>=' | '<=' | '>' | '<' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}

const ver = (major: number, minor: number, patch: number): SemVer => ({
  major,
  minor,
  patch,
  prerelease: [],
});

function caretUpper(v: SemVer): SemVer {
  if (v.major > 0) return ver(v.major + 1, 0, 0);
  if (v.minor > 0) return ver(0, v.minor + 1, 0);
  return ver(0, 0, v.patch + 1);
}

/** npm's upper bounds exclude prereleases of the bound itself (`<2.0.0-0`). */
const lowest = (v: SemVer): SemVer => ({ ...v, prerelease: ['0'] });

function expand(token: string): Comparator[] {
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) throw new TypeError(`Invalid comparator: ${token}`);
  const v = parse(m[2] ?? '');
  if (!v) throw new TypeError(`Invalid comparator: ${token}`);
  const op = m[1] ?? '=';
  if (op === '^') return [{ op: '>=', v }, { op: '<', v: lowest(caretUpper(v)) }];
  if (op === '~') return [{ op: '>=', v }, { op: '<', v: lowest(ver(v.major, v.minor + 1, 0)) }];
  return [{ op: op as Op, v }];
}

function test(c: Comparator, v: SemVer): boolean {
  const r = compareParsed(v, c.v);
  switch (c.op) {
    case '>=':
      return r >= 0;
    case '<=':
      return r <= 0;
    case '>':
      return r > 0;
    case '<':
      return r < 0;
    default:
      return r === 0;
  }
}

const sameTuple = (a: SemVer, b: SemVer): boolean =>
  a.major === b.major && a.minor === b.minor && a.patch === b.patch;

function setAllows(comparators: Comparator[], v: SemVer): boolean {
  if (!comparators.every((c) => test(c, v))) return false;
  if (!v.prerelease.length) return true;
  // A prerelease only matches when a comparator opted in with a prerelease on the same tuple.
  return comparators.some((c) => c.v.prerelease.length > 0 && sameTuple(c.v, v));
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split('||').some((set) => {
    const comparators = set.trim().split(/\s+/).filter(Boolean).flatMap(expand);
    return setAllows(comparators, v);
  });
}
