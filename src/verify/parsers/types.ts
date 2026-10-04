export interface Failure {
  /** Stable identity used by the ratchet: test path, `file:TS1234:msg`, `file:rule`… */
  id: string;
  location?: string;
  /** At most ~20 lines; this is what the model sees. */
  message: string;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ParsedOutput {
  failures: Failure[];
  tests?: TestCounts;
  /** False when the output wasn't in the expected format and the generic fallback was used. */
  structured: boolean;
}

export interface ParseContext {
  gate: string;
  exitCode: number;
  /** Absolute worktree path; stripped from locations so ids survive a moved worktree. */
  cwd: string;
}

export const MAX_MESSAGE_LINES = 20;

export function clip(message: string, lines = MAX_MESSAGE_LINES): string {
  const all = message.replace(/\r/g, '').split('\n');
  const kept = all.slice(0, lines);
  return (all.length > lines ? [...kept, `… (${all.length - lines} more lines)`] : kept)
    .join('\n')
    .trimEnd();
}

/** Make an absolute path relative to the worktree, tolerating macOS /private and file:// prefixes. */
export function relPath(path: string, cwd: string): string {
  let p = path.replace(/^file:\/\//, '');
  for (const root of [cwd, `/private${cwd}`, cwd.replace(/^\/private/, '')]) {
    if (p.startsWith(`${root}/`)) {
      p = p.slice(root.length + 1);
      break;
    }
  }
  return p;
}

/** Find the first JSON value in noisy output (e.g. `npm run` banners before the reporter). */
export function extractJson(output: string, opener: '{' | '['): unknown {
  for (let i = output.indexOf(opener); i >= 0; i = output.indexOf(opener, i + 1)) {
    const closer = opener === '{' ? '}' : ']';
    const end = output.lastIndexOf(closer);
    if (end <= i) return undefined;
    try {
      return JSON.parse(output.slice(i, end + 1)) as unknown;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}
