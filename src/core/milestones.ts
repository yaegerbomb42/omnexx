import { z } from 'zod';
import { buildCodemap, setPurposes, updateCodemap, type Codemap } from '../agent/codemap.js';
import { describeFiles } from '../agent/describe.js';
import { tagCheckpoint } from '../git/checkpoint.js';
import { readTextOr, writeJsonAtomic, writeFileAtomic } from './atomic.js';
import { estimateTokens } from './tokens.js';
import { noteSchema, renderNotes, type Note } from './notes.js';
import { childrenOf, milestonesAwaitingCheck, type PlanNode } from './plan.js';
import type { Run } from './run.js';
import { renderCodemap } from '../agent/codemap.js';

export const checkpointTag = (runId: string, milestoneId: string): string =>
  `omnexx/${runId}/${milestoneId}`;

async function milestoneChecksPass(
  run: Run,
  m: PlanNode,
): Promise<{ pass: boolean; failed: string[] }> {
  const failed: string[] = [];
  for (const [i, command] of m.checks.entries()) {
    const r = await run.exec(command, {
      cwd: run.worktree,
      env: run.childEnv,
      timeoutMs: run.maxCmdTimeoutMs,
      logPath: `${run.store.logsDir}/milestone-${m.id}-${i}.log`,
      redact: (s) => run.redactor.text(s),
      signal: run.abort.signal,
    });
    if (r.exitCode !== 0 || r.timedOut) failed.push(command);
  }
  return { pass: failed.length === 0, failed };
}

/**
 * Milestones whose tasks are all done: run their own checks on lastGreen. Pass → done, tag,
 * checkpoint record, notes consolidation. Fail → stays open; returns it so the supervisor can
 * re-plan it (plan §14.1).
 */
export async function settleMilestones(run: Run): Promise<PlanNode[]> {
  const plan = run.requirePlan();
  const failing: PlanNode[] = [];
  for (const m of milestonesAwaitingCheck(plan)) {
    const r = await milestoneChecksPass(run, m);
    if (!r.pass) {
      run.events.emit('milestone.checks_failed', { milestone: m.id, failed: r.failed });
      m.evidence = [...m.evidence, `Milestone checks failed: ${r.failed.join(', ')}`].slice(-3);
      failing.push(m);
      continue;
    }
    m.status = 'done';
    m.doneAtCycle = run.state.cycle;
    const tag = checkpointTag(run.state.runId, m.id);
    await tagCheckpoint(run.worktree, tag, run.state.lastGreen);
    const tests = run.state.baseline
      ? Object.values(run.state.baseline).reduce((n, g) => n + (g.tests?.passed ?? 0), 0)
      : undefined;
    run.state.checkpoints.push({
      milestoneId: m.id,
      sha: run.state.lastGreen,
      tag,
      at: run.clock.now(),
      usd: run.state.spend.usd,
      ...(tests !== undefined ? { tests } : {}),
    });
    run.events.emit('milestone.done', {
      milestone: m.id,
      tag,
      sha: run.state.lastGreen,
      tasks: childrenOf(plan, m.id).length,
    });
    await consolidateNotes(run);
  }
  await run.savePlan();
  await run.save();
  return failing;
}

const consolidationSchema = z.object({ notes: z.array(noteSchema.omit({ date: true })) });

/**
 * At milestone boundaries the cheap model proposes merged lessons. Applied only if the result is
 * shorter and keeps the exact text of every env/command entry (plan §14.2).
 */
export async function consolidateNotes(run: Run): Promise<boolean> {
  const notes = await run.store.readNotes();
  if (notes.length < 6) return false;
  const text = renderNotes(notes);
  try {
    const done = await run.cheapComplete(
      {
        system: [
          {
            text: 'You consolidate a lessons file: merge duplicates, drop stale entries, keep ids of kept entries. Keep every env and command entry verbatim.',
          },
        ],
        tools: [
          {
            name: 'answer',
            description: 'Submit consolidated notes',
            inputSchema: z.toJSONSchema(consolidationSchema),
          },
        ],
        toolChoice: { type: 'tool', name: 'answer' },
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: 2_000,
        messageBreakpoints: [],
      },
      { estimatedInputTokens: estimateTokens(text) + 400, maxOutputTokens: 2_000, role: 'cheap' },
    );
    if (!done) return false;
    const { res } = done;
    const call = res.content.find((b) => b.type === 'tool_use');
    const parsed = consolidationSchema.safeParse(
      call?.type === 'tool_use' ? call.input : undefined,
    );
    if (!parsed.success) return false;
    const today = new Date(run.clock.now()).toISOString().slice(0, 10);
    const next: Note[] = parsed.data.notes.map((n) => ({
      ...n,
      date: notes.find((o) => o.id === n.id)?.date ?? today,
    }));
    const keepsFacts = notes
      .filter((n) => n.type === 'env' || n.type === 'command')
      .every((f) => next.some((n) => n.text === f.text));
    const shorter = renderNotes(next).length < text.length;
    run.events.emit('notes.consolidation', {
      applied: keepsFacts && shorter,
      before: notes.length,
      after: next.length,
      keepsFacts,
      shorter,
    });
    if (!keepsFacts || !shorter) return false;
    await run.store.writeNotes(next);
    return true;
  } catch (err) {
    run.events.emit('notes.consolidation', { applied: false, error: (err as Error).message });
    return false;
  }
}

/** Build the codemap once (cycle 0) with purposes for source files. */
export async function initCodemap(run: Run): Promise<void> {
  if (await readTextOr(run.store.file('codemap.json'), '')) return;
  const map = await buildCodemap(run.worktree);
  const purposes = await describeFiles(
    run,
    map,
    map.entries.map((e) => e.path),
  );
  await saveCodemap(run, setPurposes(map, purposes));
}

/** After an accepted commit: update only the files it touched; describe only new/changed ones. */
export async function refreshCodemap(run: Run, changed: readonly string[]): Promise<void> {
  const text = await readTextOr(run.store.file('codemap.json'), '');
  if (!text || !changed.length) return;
  const { map, touched } = await updateCodemap(JSON.parse(text) as Codemap, run.worktree, changed);
  const needs = touched.filter((p) => !map.entries.find((e) => e.path === p)?.purpose);
  const purposes = needs.length ? await describeFiles(run, map, needs) : {};
  await saveCodemap(run, setPurposes(map, purposes));
  run.events.emit('codemap.updated', {
    touched: touched.length,
    described: Object.keys(purposes).length,
  });
}

async function saveCodemap(run: Run, map: Codemap): Promise<void> {
  await writeJsonAtomic(run.store.file('codemap.json'), map);
  await writeFileAtomic(
    run.store.file('codemap.md'),
    `${renderCodemap(map, run.config.context.repo_map_max_tokens)}\n`,
  );
}
