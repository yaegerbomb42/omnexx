/**
 * Cleans command output before it is trimmed into the conversation: no ANSI codes or spinner
 * frames, passing-test lines collapsed into one count, runs of identical lines folded, and
 * stack frames from dependencies folded. Deterministic and token-free; read_log keeps the raw
 * output, so nothing is lost.
 */

// Built from a string so the escape character isn't a control character inside a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Lines that only report a test passing (vitest/jest, node:test TAP, pytest, go, cargo). */
const PASSING_TEST =
  /^\s*(✓|✔|√|PASS\b|ok \d+ |--- PASS:|test .+ \.\.\. ok$|.+ PASSED(\s|$)|.+::\S+ PASSED)/;

/** Stack frames that point into dependencies or the runtime, not the project. */
const DEPENDENCY_FRAME =
  /^\s*(at .*(node_modules|node:internal|\(internal\/)|File ".*(site-packages|\.venv|dist-packages)\/)/;

/** A run must be at least this long before it is folded. */
const MIN_RUN = 3;

/** Keep what a carriage-return-redrawn line finally showed. */
function lastFrame(line: string): string {
  const frames = line.split('\r').filter((f) => f.length > 0);
  return frames.at(-1) ?? '';
}

function collapsePassing(lines: readonly string[]): string[] {
  const passing = lines.filter((l) => PASSING_TEST.test(l)).length;
  if (passing < MIN_RUN) return [...lines];
  const rest = lines.filter((l) => !PASSING_TEST.test(l));
  return [`[✓ ${String(passing)} passing lines collapsed]`, ...rest];
}

function foldDependencyFrames(lines: readonly string[]): string[] {
  const out: string[] = [];
  let run = 0;
  const flush = (): void => {
    if (run > 0) out.push(`    [${String(run)} dependency frame${run === 1 ? '' : 's'} folded]`);
    run = 0;
  };
  for (const line of lines) {
    if (DEPENDENCY_FRAME.test(line)) {
      run += 1;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

function foldRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i] ?? '';
    let j = i + 1;
    while (j < lines.length && lines[j] === first) j += 1;
    const extra = j - i - 1;
    out.push(first);
    if (extra + 1 >= MIN_RUN) out.push(`[… ${String(extra)} more like this]`);
    else out.push(...lines.slice(i + 1, j));
    i = j;
  }
  return out;
}

export function compressOutput(output: string): string {
  const lines = output.replace(ANSI, '').replace(/\s+$/, '').split('\n').map(lastFrame);
  return foldRepeats(foldDependencyFrames(collapsePassing(lines))).join('\n');
}
