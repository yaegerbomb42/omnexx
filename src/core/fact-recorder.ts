import type { Executor, ExecResult } from './exec.js';
import {
  applyVerification,
  bindingHashes,
  classifyCommand,
  readFacts,
  writeFacts,
  type FactKind,
  type Verification,
} from './facts.js';
import type { Note } from './notes.js';
import type { OmnexxPaths } from './paths.js';

/** Exit code recorded for a command the harness timed out. */
const TIMED_OUT_EXIT = 124;
/** Passing commands remembered as evidence for the remember tool, per session. */
const MAX_EVIDENCE = 100;

const PHRASE: Record<FactKind, string> = {
  test: 'tests pass with',
  build: 'builds with',
  lint: 'lint passes with',
  typecheck: 'typechecks with',
  env: 'dependencies install with',
  run: 'runs with',
  path: 'path checked with',
  convention: 'convention checked with',
};

const NOTE_KIND: Partial<Record<Note['type'], FactKind>> = {
  env: 'env',
  convention: 'convention',
  pitfall: 'convention',
};

export interface FactRecorderOptions {
  paths: Pick<OmnexxPaths, 'home'>;
  /** The repo whose facts these are (its memory key). */
  repoRoot: string;
  /** Where commands run and binding files are hashed (a run's worktree, or the repo). */
  workdir: string;
  /** Configured gate commands: their passes are recorded as gate facts. */
  gateCommands?: readonly string[];
  now: () => number;
  onError?: (err: Error) => void;
}

/**
 * Watches commands the harness runs and keeps the repo's verified facts up to date. Writes are
 * serialized and never fail the command: a broken facts file only loses facts.
 */
export class FactRecorder {
  private queue: Promise<void> = Promise.resolve();
  /** Commands that passed this session, newest last: evidence for remembered facts. */
  private readonly passed = new Map<string, { durationMs: number; at: string }>();

  constructor(private readonly o: FactRecorderOptions) {}

  /** An executor that runs `exec` and records what it ran. */
  wrap(exec: Executor): Executor {
    return async (command, opts) => {
      const r = await exec(command, opts);
      this.observe(command, r);
      return r;
    };
  }

  observe(command: string, r: Pick<ExecResult, 'exitCode' | 'timedOut' | 'durationMs'>): void {
    const exitCode = r.timedOut ? TIMED_OUT_EXIT : r.exitCode;
    const at = new Date(this.o.now()).toISOString();
    const cmd = command.trim();
    if (exitCode === 0) this.notePassed(cmd, r.durationMs, at);
    const kind = classifyCommand(cmd);
    if (!kind) return;
    const source = this.o.gateCommands?.some((g) => g.trim() === cmd) ? 'gate' : 'command';
    this.enqueue([
      {
        kind,
        statement: `${PHRASE[kind]} \`${cmd}\``,
        command: cmd,
        source,
        exitCode,
        durationMs: r.durationMs,
        at,
      },
    ]);
  }

  /**
   * Lessons that name a command (in backticks) which passed this session become verified
   * facts with the lesson's wording: the agent stated it, the harness saw the evidence.
   */
  promoteNotes(notes: readonly Note[]): void {
    const found: Verification[] = [];
    for (const n of notes) {
      for (const [, cmd = ''] of n.text.matchAll(/`([^`]+)`/g)) {
        const run = this.passed.get(cmd.trim());
        const kind = n.type === 'command' ? (classifyCommand(cmd) ?? 'run') : NOTE_KIND[n.type];
        if (!run || !kind) continue;
        found.push({
          kind,
          statement: n.text,
          command: cmd.trim(),
          source: 'remember',
          exitCode: 0,
          ...run,
        });
      }
    }
    if (found.length) this.enqueue(found);
  }

  /** Resolves once every recorded run is written. */
  flush(): Promise<void> {
    return this.queue;
  }

  private notePassed(cmd: string, durationMs: number, at: string): void {
    this.passed.delete(cmd);
    this.passed.set(cmd, { durationMs, at });
    if (this.passed.size > MAX_EVIDENCE) {
      const oldest = this.passed.keys().next().value;
      if (oldest !== undefined) this.passed.delete(oldest);
    }
  }

  private enqueue(vs: readonly Verification[]): void {
    this.queue = this.queue
      .then(() => this.write(vs))
      .catch((err: unknown) => {
        this.o.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private async write(vs: readonly Verification[]): Promise<void> {
    const { paths, repoRoot, workdir } = this.o;
    const boundTo = await bindingHashes(workdir);
    let facts = await readFacts(paths, repoRoot);
    for (const v of vs) facts = applyVerification(facts, v, boundTo);
    await writeFacts(paths, repoRoot, facts);
  }
}
