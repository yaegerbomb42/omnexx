import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { contextFiles, setSectionMode } from '../../src/cli/chat-context.js';
import type { CliIO } from '../../src/cli/io.js';
import { loadConfig } from '../../src/config/load.js';
import { supervise } from '../../src/core/supervisor.js';
import { fileTask, fileWorker, planner, scenario } from '../support/scenarios.js';
import { ScriptedProvider } from '../support/scripted-provider.js';
import { FAST_SUPERVISE, makeRepo, PASSING_GATE, startTestRun } from '../support/harness.js';

describe('Context explorer data', () => {
  it('lists the role card a cycle wrote, every section with its mode, and the notes', async () => {
    const plan = planner([{ id: 'M1', title: 'Ship', tasks: [fileTask('M1.T01')] }]);
    const seen: string[] = [];
    const t = await startTestRun({
      repo: await makeRepo(),
      provider: new ScriptedProvider((m) => {
        if (!m.planner) seen.push(JSON.stringify(m.request.messages[0]));
        return scenario(plan, fileWorker)(m);
      }),
      config: { gates: [PASSING_GATE] },
    });
    await supervise(t.run.deps, t.run.state.runId, FAST_SUPERVISE);
    // The worker saw its role card and the table of contents (codemap is optional by default).
    expect(seen[0]).toContain('Role: Implementer for M1.T01');
    expect(seen[0]).toContain('More context, when you need it');

    const io: CliIO = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: t.env,
      cwd: t.repo,
      isTTY: false,
    };
    const { runId, files } = await contextFiles(io);
    expect(runId).toBe(t.run.state.runId);
    const byId = new Map(files.map((f) => [f.id, f]));
    expect(byId.get('codemap')).toMatchObject({ mode: 'optional', editable: false });
    expect(byId.get('lessons')).toMatchObject({ mode: 'pinned', editable: false });
    expect(byId.get('repo-notes')).toMatchObject({ editable: true });
    expect(byId.get('goal')).toMatchObject({ exists: true, editable: true });

    await setSectionMode(io, 'lessons', 'hidden');
    const { config } = await loadConfig({ cwd: t.repo, env: t.env });
    expect(config.context.sections.lessons).toBe('hidden');
    expect((await contextFiles(io)).files.find((f) => f.id === 'lessons')?.mode).toBe('hidden');
    await expect(setSectionMode(io, 'nope', 'hidden')).rejects.toThrow(/no section/);
    await expect(setSectionMode(io, 'lessons', 'loud')).rejects.toThrow(/mode is one of/);
    expect(await readFile(byId.get('goal')?.path ?? '', 'utf8')).toMatch(/\S/);
  });
});
