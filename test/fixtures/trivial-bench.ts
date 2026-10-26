/**
 * Fixed bench for the trivial fast path (token efficiency + speed). A "trivial" goal is a short,
 * one-line change to a single file, e.g. "bump the version in package.json to 2.0.0". Quick mode
 * finishes these as a single-shot worker pass (one edit + the targeted check) instead of a full
 * plan/think/verify loop. Each fixture lists the goal, the single file it names, and the cost
 * bounds the trivial path must meet: at most 3 turns and 8,000 tokens.
 */
export interface TrivialBenchCase {
  goal: string;
  file: string;
}

export const TRIVIAL_BENCH: readonly TrivialBenchCase[] = [
  { goal: 'bump the version in package.json to 2.0.0', file: 'package.json' },
  { goal: 'fix the off-by-one in src/math.js', file: 'src/math.js' },
  { goal: 'update the year in LICENSE.txt to 2027', file: 'LICENSE.txt' },
  { goal: 'increase the timeout in tsconfig.json to 30s', file: 'tsconfig.json' },
  { goal: 'add the missing semicolon in src/index.ts', file: 'src/index.ts' },
];
