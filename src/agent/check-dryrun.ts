import { join } from 'node:path';
import type { PlanUpdate } from '../core/plan.js';
import type { Run } from '../core/run.js';

/** Plan-time dry runs are quick probes, not the real verification. */
const DRYRUN_TIMEOUT_MS = 60_000;
const MAX_DRYRUNS = 15;

/** The check itself is broken (the shell or an inline script couldn't parse it), not the code. */
const BROKEN =
  /\b(sh|bash|zsh|dash)(: line \d+)?: .*(syntax error|unexpected EOF|unterminated|bad substitution)|command not found|\[eval\]:\d+[\s\S]*SyntaxError/i;

export interface DryRunFindings {
  /** Checks that can never pass as written, with the shell's complaint. */
  broken: string[];
  /** Code tasks whose every check already passes, so none of them can show the change. */
  alreadyPass: string[];
}

/**
 * Run each check of the update's code tasks once on the current worktree (deduped, capped).
 * Planner models write checks that can't parse (a quoting slip) or that pass before any work,
 * which later cost whole cycles of retries or let a task close with nothing done.
 */
export async function dryRunChecks(
  run: Run,
  update: PlanUpdate,
  cache: Map<string, { exitCode: number | null; output: string }>,
): Promise<DryRunFindings> {
  const found: DryRunFindings = { broken: [], alreadyPass: [] };
  for (const m of update.milestones)
    for (const t of m.tasks ?? []) {
      const checks = t.checks ?? [];
      if (!checks.length || t.kind === 'docs' || t.kind === 'investigate') continue;
      let passing = 0;
      for (const c of checks) {
        let r = cache.get(c);
        if (!r) {
          if (cache.size >= MAX_DRYRUNS) break;
          const out = await run.exec(c, {
            cwd: run.worktree,
            env: run.childEnv,
            timeoutMs: Math.min(DRYRUN_TIMEOUT_MS, run.maxCmdTimeoutMs),
            logPath: join(run.store.logsDir, `check-dryrun-${cache.size}.log`),
            redact: (s) => run.redactor.text(s),
            signal: run.abort.signal,
          });
          r = { exitCode: out.timedOut ? null : out.exitCode, output: out.output };
          cache.set(c, r);
        }
        if (r.exitCode === 0) passing++;
        else if (r.exitCode === 127 || BROKEN.test(r.output))
          found.broken.push(
            `${t.id}: \`${c}\` cannot run as written:\n${r.output.trim().split('\n').slice(-4).join('\n')}`,
          );
      }
      if (passing === checks.length)
        found.alreadyPass.push(`${t.id}: ${checks.map((c) => `\`${c}\``).join(', ')}`);
    }
  return found;
}
