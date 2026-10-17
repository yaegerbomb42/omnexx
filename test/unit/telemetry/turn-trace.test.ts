import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { turnTraceLine } from '../../../src/telemetry/humanize.js';
import { collectTrace, turnWarning, type TraceCall } from '../../../src/telemetry/turn-trace.js';
import { Session, type RunCli } from '../../../src/tui/session.js';
import { tempDir } from '../../support/tmp.js';

const call = (tool: string, error = ''): TraceCall => ({
  tool,
  isError: error.length > 0,
  error,
});

const turn = (
  n: number,
  tokens: { uncached: number; cacheWrite: number; cacheRead: number; output: number },
  ms: number,
) => ({
  ts: 1,
  runId: 'r',
  cycle: 1,
  type: 'turn',
  turn: n,
  ms,
  tokens,
});

describe('turn trace line', () => {
  it('renders a two-call turn with cache tokens, and warns on a one-call read', () => {
    const tokens = { uncached: 400, cacheWrite: 1_100, cacheRead: 8_000, output: 20 };
    const two = collectTrace([
      turn(2, tokens, 1_200),
      { type: 'tool.call', tool: 'search', isError: false },
      { type: 'tool.call', tool: 'read', isError: false },
      { type: 'verify.gates', gates: [{ gate: 'test', exitCode: 0 }] },
      turn(3, tokens, 10),
    ]);
    expect(two.map(turnTraceLine)).toEqual([
      'turn 2  2 calls  fresh 1.5k  cached 8.0k  1.2s  gates ok',
    ]);
    const one = collectTrace([
      turn(4, { uncached: 80, cacheWrite: 0, cacheRead: 3_400, output: 5 }, 400),
      { type: 'tool.call', tool: 'read', isError: false },
      turn(5, tokens, 10),
    ]);
    expect(one.map(turnTraceLine)[0]).toBe(
      '! turn 4  1 call  fresh 80  cached 3.4k  400ms  gates —',
    );
  });

  it('warns for notes-only turns, denied commands, and failed edits', () => {
    expect(turnWarning([call('todo'), call('remember')])).toBe(true);
    expect(turnWarning([call('bash', 'command denied by policy')])).toBe(true);
    expect(turnWarning([call('bash', 'exit 1')])).toBe(true);
    expect(turnWarning([call('str_replace', 'old string not found')])).toBe(true);
    expect(turnWarning([call('read'), call('search')])).toBe(false);
    expect(turnWarning([])).toBe(false);
  });
});

describe('session trace', () => {
  it('leaves the default feed unchanged until /trace', async () => {
    const home = await tempDir();
    const io = {
      env: { OMNEXX_HOME: home, OMNEXX_CONFIG_HOME: join(home, 'cfg') },
      cwd: home,
      isTTY: false,
    } as unknown as CliIO;
    const cli: RunCli = () => Promise.resolve(0);
    const s = new Session(io, cli, () => 10_000);
    const root = resolvePaths(io.env).home;
    const dir = join(root, 'runs', 'r_trace');
    await mkdir(dir, { recursive: true });
    const tokens = { uncached: 400, cacheWrite: 1_100, cacheRead: 8_000, output: 20 };
    const events = [
      turn(2, tokens, 1_200),
      { ts: 2, runId: 'r_trace', cycle: 1, type: 'tool.call', tool: 'search', isError: false },
      { ts: 3, runId: 'r_trace', cycle: 1, type: 'tool.call', tool: 'read', isError: false },
      {
        ts: 4,
        runId: 'r_trace',
        cycle: 1,
        type: 'verify.gates',
        gates: [{ gate: 'test', exitCode: 0 }],
      },
      turn(3, tokens, 10),
    ];
    await writeFile(
      join(dir, 'events.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
    await writeFile(join(dir, 'goal.md'), '# Goal\n\nbuild it\n');
    await s.attach('r_trace');
    const traced = (text: string): boolean => text.startsWith('turn ') || text.startsWith('! turn');
    expect(s.entries.some((e) => traced(e.text))).toBe(false);
    await s.submit('/trace');
    expect(s.trace).toBe(true);
    await appendFile(
      join(dir, 'events.jsonl'),
      `${JSON.stringify(turn(4, { uncached: 80, cacheWrite: 0, cacheRead: 3_400, output: 5 }, 400))}\n${JSON.stringify({ ts: 6, runId: 'r_trace', cycle: 1, type: 'tool.call', tool: 'read', isError: false })}\n${JSON.stringify(turn(5, tokens, 10))}\n`,
    );
    await s.poll();
    expect(s.entries.some((e) => e.kind === 'feed' && e.text.startsWith('! turn 4'))).toBe(true);
  });
});
