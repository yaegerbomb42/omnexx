import type { GateParser } from '../../config/schema.js';
import {
  clip,
  extractJson,
  relPath,
  type Failure,
  type ParseContext,
  type ParsedOutput,
} from './types.js';

const ERROR_LINE = /\b(error|fail(ed|ure)?|exception|panic|traceback|assert)/i;
const STACK_NOISE = /^\s+at .*(node_modules|node:internal)/;

const cleanStack = (msg: string): string =>
  msg
    .split('\n')
    .filter((l) => !STACK_NOISE.test(l))
    .join('\n');

/** Exit code plus the most error-looking lines. Used when no parser applies or parsing fails. */
export function parseGeneric(output: string, ctx: ParseContext): ParsedOutput {
  if (ctx.exitCode === 0) return { failures: [], structured: false };
  const lines = output.split('\n');
  const interesting = lines.filter((l) => ERROR_LINE.test(l));
  const message = clip((interesting.length ? interesting : lines.slice(-20)).join('\n'));
  return {
    failures: [{ id: `${ctx.gate}:exit`, message: message || `exit code ${ctx.exitCode}` }],
    structured: false,
  };
}

interface JestLike {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: {
    name?: string;
    message?: string;
    status?: string;
    assertionResults?: {
      fullName?: string;
      title?: string;
      ancestorTitles?: string[];
      status?: string;
      failureMessages?: string[];
      location?: { line?: number } | null;
    }[];
  }[];
}

/** vitest `--reporter=json` and jest `--json` share this shape. */
export function parseJestLike(output: string, ctx: ParseContext): ParsedOutput {
  const data = extractJson(output, '{') as JestLike | undefined;
  if (!data || !Array.isArray(data.testResults)) return parseGeneric(output, ctx);
  const failures: Failure[] = [];
  for (const file of data.testResults) {
    const rel = relPath(file.name ?? '', ctx.cwd);
    const asserts = file.assertionResults ?? [];
    for (const a of asserts) {
      if (a.status !== 'failed') continue;
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ''].join(' ');
      failures.push({
        id: `${rel} > ${name}`,
        location: a.location?.line ? `${rel}:${a.location.line}` : rel,
        message: clip(
          cleanStack((a.failureMessages ?? []).join('\n'))
            .split(ctx.cwd)
            .join('.'),
        ),
      });
    }
    // A file that failed to load (syntax error, missing import) has no assertion results.
    if (file.status === 'failed' && !asserts.some((a) => a.status === 'failed')) {
      failures.push({
        id: `${rel} > (file failed to run)`,
        location: rel,
        message: clip(cleanStack(file.message ?? '')),
      });
    }
  }
  const total = data.numTotalTests ?? 0;
  return {
    failures,
    tests: {
      total,
      passed: data.numPassedTests ?? 0,
      failed: data.numFailedTests ?? 0,
      skipped: (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0),
    },
    structured: true,
  };
}

/** `node --test --test-reporter=tap`: nested subtests; only leaf test failures count. */
export function parseNodeTap(output: string, ctx: ParseContext): ParsedOutput {
  if (!/^TAP version/m.test(output)) return parseGeneric(output, ctx);
  const lines = output.split('\n');
  const failures: Failure[] = [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const depth = (sub[1] ?? '').length / 4;
      names.length = depth;
      names[depth] = sub[2] ?? '';
      continue;
    }
    const nok = /^(\s*)not ok \d+ - (.*?)(\s+#.*)?$/.exec(line);
    if (!nok) continue;
    const depth = (nok[1] ?? '').length / 4;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (/^\s*\.\.\.\s*$/.test(l)) break;
      block.push(l);
    }
    const yaml = block.join('\n');
    if (yaml.includes("failureType: 'subtestsFailed'")) continue;
    const loc = /location: '([^']+)'/.exec(yaml)?.[1];
    const rel = loc ? relPath(loc, ctx.cwd) : undefined;
    const file = rel?.replace(/:\d+:\d+$/, '') ?? '';
    const path = [...names.slice(0, depth), nok[2] ?? ''].join(' > ');
    const errMatch =
      /error: \|-\n([\s\S]*?)\n\s+(code|name|expected|stack|failureType):/.exec(yaml) ??
      /error: '([^']*)'/.exec(yaml);
    const msg = (errMatch?.[1] ?? 'test failed')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    failures.push({
      id: `${file} > ${path}`,
      ...(rel ? { location: rel } : {}),
      message: clip(msg),
    });
  }
  const n = (k: string): number => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(output)?.[1] ?? 0);
  const total = n('tests');
  return {
    failures,
    tests: {
      total,
      passed: n('pass'),
      failed: n('fail') + n('cancelled'),
      skipped: n('skipped') + n('todo'),
    },
    structured: true,
  };
}

/** `tsc` diagnostics: `file(line,col): error TS1234: message`. */
export function parseTsc(output: string, ctx: ParseContext): ParsedOutput {
  const failures: Failure[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;
  for (const m of output.matchAll(re)) {
    const file = relPath(m[1] ?? '', ctx.cwd);
    failures.push({
      id: `${file}:${m[4] ?? ''}:${m[5] ?? ''}`,
      location: `${file}:${m[2] ?? ''}:${m[3] ?? ''}`,
      message: `${m[4] ?? ''}: ${m[5] ?? ''}`,
    });
  }
  if (!failures.length && ctx.exitCode !== 0) return parseGeneric(output, ctx);
  return { failures, structured: true };
}

interface EslintFile {
  filePath?: string;
  messages?: {
    ruleId?: string | null;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
  }[];
}

/** eslint `-f json`, falling back to the default "stylish" text format. Errors only (severity 2). */
export function parseEslint(output: string, ctx: ParseContext): ParsedOutput {
  const data = extractJson(output, '[') as EslintFile[] | undefined;
  const failures: Failure[] = [];
  if (Array.isArray(data)) {
    for (const f of data) {
      const file = relPath(f.filePath ?? '', ctx.cwd);
      for (const m of f.messages ?? []) {
        if (m.severity !== 2) continue;
        const rule = m.ruleId ?? 'fatal';
        failures.push({
          id: `${file}:${rule}`,
          location: `${file}:${m.line ?? 0}:${m.column ?? 0}`,
          message: `${rule}: ${m.message ?? ''}`,
        });
      }
    }
    return { failures, structured: true };
  }
  let file = '';
  for (const line of output.split('\n')) {
    if (/^\S.*\.[cm]?[jt]sx?$/.test(line.trim()) && !line.startsWith(' '))
      file = relPath(line.trim(), ctx.cwd);
    const m = /^\s+(\d+):(\d+)\s+error\s+(.*?)\s{2,}(\S+)\s*$/.exec(line);
    if (m && file)
      failures.push({
        id: `${file}:${m[4] ?? ''}`,
        location: `${file}:${m[1] ?? ''}:${m[2] ?? ''}`,
        message: `${m[4] ?? ''}: ${m[3] ?? ''}`,
      });
  }
  if (!failures.length && ctx.exitCode !== 0) return parseGeneric(output, ctx);
  return { failures, structured: failures.length > 0 || ctx.exitCode === 0 };
}

/** pytest with `-rf`: `FAILED path::test - message` lines plus the summary line. */
export function parsePytest(output: string, ctx: ParseContext): ParsedOutput {
  const failures: Failure[] = [];
  for (const m of output.matchAll(/^(FAILED|ERROR) (\S+?)(?: - (.*))?$/gm)) {
    failures.push({
      id: m[2] ?? '',
      location: (m[2] ?? '').split('::')[0] ?? '',
      message: clip(m[3] ?? m[1] ?? 'failed'),
    });
  }
  const summary = /^=+ (.*) in [\d.]+s.*=+$/m.exec(output)?.[1];
  if (!summary) return failures.length ? { failures, structured: true } : parseGeneric(output, ctx);
  const count = (k: string): number => Number(new RegExp(`(\\d+) ${k}`).exec(summary)?.[1] ?? 0);
  const failed = count('failed') + count('errors?');
  const passed = count('passed');
  const skipped = count('skipped') + count('xfailed');
  return {
    failures,
    tests: { total: failed + passed + skipped, passed, failed, skipped },
    structured: true,
  };
}

/** `go test -json`: one JSON object per line with Action pass/fail/skip per Test. */
export function parseGoTest(output: string, ctx: ParseContext): ParsedOutput {
  const outputs = new Map<string, string[]>();
  const results = new Map<string, string>();
  let sawJson = false;
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: { Action?: string; Package?: string; Test?: string; Output?: string };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    sawJson = true;
    if (!ev.Test) continue;
    const key = `${ev.Package ?? ''}.${ev.Test}`;
    if (ev.Action === 'output' && ev.Output)
      outputs.set(key, [...(outputs.get(key) ?? []), ev.Output.trim()]);
    if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip')
      results.set(key, ev.Action);
  }
  if (!sawJson) return parseGeneric(output, ctx);
  const failures: Failure[] = [];
  let passed = 0;
  let skipped = 0;
  for (const [key, action] of results) {
    if (action === 'pass') passed++;
    else if (action === 'skip') skipped++;
    else
      failures.push({
        id: key,
        message: clip(
          (outputs.get(key) ?? []).filter((l) => !/^(=== RUN|--- FAIL)/.test(l)).join('\n'),
        ),
      });
  }
  return {
    failures,
    tests: { total: results.size, passed, failed: failures.length, skipped },
    structured: true,
  };
}

export function parseGateOutput(
  parser: GateParser,
  output: string,
  ctx: ParseContext,
): ParsedOutput {
  switch (parser) {
    case 'vitest':
    case 'jest':
      return parseJestLike(output, ctx);
    case 'node-test':
      return parseNodeTap(output, ctx);
    case 'tsc':
      return parseTsc(output, ctx);
    case 'eslint':
      return parseEslint(output, ctx);
    case 'pytest':
      return parsePytest(output, ctx);
    case 'gotest':
      return parseGoTest(output, ctx);
    case 'generic':
      return parseGeneric(output, ctx);
  }
}
