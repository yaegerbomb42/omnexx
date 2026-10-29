/**
 * Cleans command output before it is trimmed into the conversation: no ANSI codes or spinner
 * frames, passing-test lines collapsed into one count, runs of identical lines folded,
 * stack frames from dependencies folded, package manager and build noise stripped/collapsed,
 * and git tutorial advice omitted. Deterministic and token-free; read_log keeps the raw
 * output, so nothing is lost.
 */

// Built from a string so the escape character isn't a control character inside a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Lines that only report a test passing (vitest/jest, node:test TAP, pytest, go, cargo). */
const PASSING_TEST =
  /^\s*(✓|✔|√|PASS\b|ok \d+ |--- PASS:|test .+ \.\.\. ok$|.+ PASSED(\s|$)|.+::\S+ PASSED)/;

/** Test runner intermediate progress or queued notifications. */
const TEST_QUEUED = /^\s*[❯›]\s+.*(?:\[queued\]|\b0\/\d+\b)/;

/** Stack frames that point into dependencies or the runtime, not the project. */
const DEPENDENCY_FRAME =
  /^\s*(at .*(node_modules|node:internal|\(internal\/|bun:internal|\(bun:)|File ".*(site-packages|\.venv|dist-packages)\/)/;

/** Git tutorial advice lines emitted by git status/restore. */
const GIT_ADVICE =
  /^\s*\((?:use "git (?:add|restore|checkout|rm|commit|reset)[^"]*"[^)]*|commit or discard [^)]*)\)/;

/** Package manager boilerplate/notice noise (npm, yarn, pnpm, bun). */
const PKG_NOISE =
  /^\s*(?:npm\s+(?:warn|WARN|notice|NOTICE|http|verb|info)\b|(?:\d+\s+packages?\s+(?:are\s+looking\s+for\s+funding|looking\s+for\s+funding)|run\s+[`'"]?npm\s+fund[`'"]?|found\s+\d+\s+vulnerabilities|(?:added|audited|removed|changed)\s+\d+\s+packages?|\[\d+\/\d+\]\s+(?:Resolving|Fetching|Linking|Building)|➤\s+YN\d{4}:))/;

/** Build progress tickers (vite, webpack, rollup). */
const BUILD_PROGRESS =
  /^\s*(?:transforming\s*\(\d+(?:\/\d+)?\)|rendering chunks\.\.\.|computing gzip size\.\.\.)/i;

/** A run must be at least this long before it is folded. */
const MIN_RUN = 3;

/** Keep what a carriage-return-redrawn line finally showed. */
function lastFrame(line: string): string {
  const frames = line.split('\r').filter((f) => f.length > 0);
  return frames.at(-1) ?? '';
}

function isPackageNoise(line: string): boolean {
  if (/\b(?:error|err!|failed|failure)\b/i.test(line)) return false;
  return PKG_NOISE.test(line);
}

function foldPackageNoise(lines: readonly string[]): string[] {
  const out: string[] = [];
  let run = 0;
  let firstLine = '';
  const flush = (): void => {
    if (run >= 2) {
      out.push(`[package manager: ${String(run)} warning/notice lines collapsed]`);
    } else if (run === 1) {
      out.push(firstLine);
    }
    run = 0;
    firstLine = '';
  };
  for (const line of lines) {
    if (isPackageNoise(line)) {
      if (run === 0) firstLine = line;
      run += 1;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

function foldBuildProgress(lines: readonly string[]): string[] {
  const out: string[] = [];
  let run = 0;
  let firstLine = '';
  const flush = (): void => {
    if (run >= 2) {
      out.push(`[build: ${String(run)} progress lines collapsed]`);
    } else if (run === 1) {
      out.push(firstLine);
    }
    run = 0;
    firstLine = '';
  };
  for (const line of lines) {
    if (BUILD_PROGRESS.test(line)) {
      if (run === 0) firstLine = line;
      run += 1;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
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

function collapseBlankLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (!blank && out.length > 0) {
        out.push('');
        blank = true;
      }
    } else {
      blank = false;
      out.push(line);
    }
  }
  return out;
}

export function compressOutput(output: string): string {
  const rawLines = output.replace(ANSI, '').replace(/\s+$/, '').split('\n').map(lastFrame);
  const filtered = rawLines.filter((l) => !TEST_QUEUED.test(l) && !GIT_ADVICE.test(l));
  const buildFolded = foldBuildProgress(filtered);
  const pkgFolded = foldPackageNoise(buildFolded);
  const passingFolded = collapsePassing(pkgFolded);
  const depFolded = foldDependencyFrames(passingFolded);
  const blankFolded = collapseBlankLines(depFolded);
  const repeatsFolded = foldRepeats(blankFolded);
  return repeatsFolded.join('\n');
}
