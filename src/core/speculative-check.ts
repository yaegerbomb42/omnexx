import { join } from 'node:path';
import { runShell, type Executor } from '../core/exec.js';
import { checkTs, TS_EXTENSIONS } from '../tools/ts-check.js';
import type { Diag } from '../tools/ts-check.js';

/**
 * Speculative gate streaming.
 *
 * The model writes a file and then waits for the next turn while the harness verifies it.
 * The verification (a typecheck, a lint) can start the moment the file lands, so it runs
 * while the model is still streaming its next message instead of after it. The result is
 * reused: the check that follows the write finds the work already done.
 *
 * The checks run in the background and are keyed by the content hash of the file they
 * checked. A file that changed since the check ran has a different hash, so a stale result
 * is never handed out — the same rule the speculative gate runs follow.
 */

/** How long a speculative check may take before it is abandoned. */
export const SPECULATIVE_CHECK_TIMEOUT_MS = 20_000;

/** The result of one speculative check. */
export interface SpeculativeCheckResult {
  /** The file the check ran against. */
  path: string;
  /** The hash of the file's bytes when the check ran: the result's identity. */
  hash: string;
  /** The diagnostics the check found (empty when it passed). */
  diags: Diag[];
  /** How long the check took. */
  ms: number;
  /** True when the check finished cleanly; false when it timed out or the tool was missing. */
  ok: boolean;
}

/** What a speculative checker does for one file: the diagnostics it found. */
export type SpeculativeChecker = (path: string, text: string) => Promise<Diag[]>;

/** The hash of a file's bytes: what a check result is keyed by. */
export function contentHash(text: string): string {
  // A cheap but stable hash: the check only compares hashes with each other.
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${text.length.toString(16)}`;
}

/**
 * The checks a repo can run on one file, without a full test suite: the TypeScript
 * diagnostics for a TS file, and the project's lint command when it names a file.
 */
export interface SpeculativeChecksOptions {
  /** Where commands run: the host, or the run's sandbox. */
  exec?: Executor | undefined;
  /** The repo root. */
  root: string;
  /** The environment commands run in. */
  env: Record<string, string>;
  /** How long a check may take. */
  timeoutMs?: number | undefined;
  /** The lint command, with the file appended (e.g. "npx eslint"). Unset: no lint check. */
  lint?: string | undefined;
  /** Stops a running check when the run ends. */
  signal?: AbortSignal | undefined;
}

/** The TypeScript diagnostics of a file, from the repo's own compiler. */
async function tsDiagnostics(
  root: string,
  path: string,
  text: string,
  timeoutMs: number,
): Promise<Diag[] | undefined> {
  // The checker compares the file's diagnostics before and after the edit; here the file is
  // already written, so "before" is empty and every diagnostic is a new one.
  const pair = await checkTs(root, path, '', text, timeoutMs);
  if (!pair) return undefined;
  return pair.after;
}

/** The project's lint command, run on one file: its output as one diagnostic per line. */
async function lintDiagnostics(
  opts: SpeculativeChecksOptions,
  path: string,
  timeoutMs: number,
): Promise<Diag[] | undefined> {
  if (!opts.lint) return undefined;
  const r = await (opts.exec ?? runShell)(`${opts.lint} ${JSON.stringify(path)}`, {
    cwd: opts.root,
    env: opts.env,
    timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (r.aborted) return undefined;
  const out: Diag[] = [];
  for (const line of r.output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = /^(.+?):(\d+):(\d+)/.exec(trimmed);
    out.push({
      line: at ? Number(at[2]) : 0,
      code: 'lint',
      message: trimmed.slice(0, 300),
    });
  }
  return out;
}

/**
 * The background checker for one cycle: files are checked as they are written, and the
 * results are kept until the file changes. At most one check per file is in flight; a second
 * write to the same file replaces the pending one.
 */
export class SpeculativeFileChecks {
  private readonly results = new Map<string, SpeculativeCheckResult>();
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private stopped = false;

  constructor(private readonly opts: SpeculativeChecksOptions) {}

  /** The result for a file, when it was checked and the file has not changed since. */
  get(path: string, hash: string): SpeculativeCheckResult | undefined {
    const hit = this.results.get(path);
    return hit?.hash === hash ? hit : undefined;
  }

  /** The number of finished checks kept. */
  get size(): number {
    return this.results.size;
  }

  /**
   * Start a check for a file that was just written. Returns immediately: the check runs in
   * the background while the model keeps streaming. `text` is the file's new content.
   */
  touch(path: string, text: string): void {
    if (this.stopped) return;
    const hash = contentHash(text);
    // A changed file invalidates the old result right away: it must never be handed out.
    const stale = this.results.get(path);
    if (stale && stale.hash !== hash) this.results.delete(path);
    const running = this.inFlight.get(path);
    if (running) running.controller.abort();
    const controller = new AbortController();
    const attempt = { controller, done: Promise.resolve() };
    attempt.done = this.run(path, text, hash, controller).catch(() => undefined);
    this.inFlight.set(path, attempt);
  }

  /**
   * Wait for a file's check to finish and return its result, when there is one for exactly
   * these bytes. A check still running is awaited (it is the work the caller would start).
   */
  async take(path: string, hash: string): Promise<SpeculativeCheckResult | undefined> {
    const running = this.inFlight.get(path);
    if (running) await running.done;
    return this.get(path, hash);
  }

  /** The session is over: stop every running check and accept no more work. */
  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.inFlight.values()];
    for (const r of running) r.controller.abort();
    await Promise.all(running.map((r) => r.done));
    this.inFlight.clear();
  }

  private async run(
    path: string,
    text: string,
    hash: string,
    controller: AbortController,
  ): Promise<void> {
    const timeoutMs = this.opts.timeoutMs ?? SPECULATIVE_CHECK_TIMEOUT_MS;
    const started = Date.now();
    try {
      const diags = await this.check(path, text, timeoutMs, controller.signal);
      if (controller.signal.aborted) return;
      this.results.set(path, {
        path,
        hash,
        diags: diags ?? [],
        ms: Date.now() - started,
        ok: diags !== undefined,
      });
    } finally {
      this.inFlight.delete(path);
    }
  }

  private async check(
    path: string,
    text: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Diag[] | undefined> {
    const abs = join(this.opts.root, path);
    const diags: Diag[] = [];
    let ran = false;
    if (TS_EXTENSIONS.test(abs)) {
      const ts = await tsDiagnostics(this.opts.root, abs, text, timeoutMs);
      if (signal.aborted) return undefined;
      if (ts) {
        ran = true;
        diags.push(...ts);
      }
    }
    if (!signal.aborted) {
      const lint = await lintDiagnostics(this.opts, path, timeoutMs);
      if (lint) {
        ran = true;
        diags.push(...lint);
      }
    }
    if (!ran) return undefined;
    return diags;
  }
}

/** The diagnostics of a file as one compact block, for the agent's context. */
export function renderCheckDiags(result: SpeculativeCheckResult): string {
  if (!result.diags.length) return '';
  const rows = result.diags
    .slice(0, 20)
    .map((d) => `⚠ line ${String(d.line)}: ${d.code} ${d.message}`);
  const more = result.diags.length > 20 ? `\n(+${String(result.diags.length - 20)} more)` : '';
  return `\n${rows.join('\n')}${more}`;
}
