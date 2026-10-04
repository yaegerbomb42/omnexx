/**
 * Test-only entry for real child processes (detach, reboot and chaos tests). It runs the real
 * CLI (`runCli`) with a scripted provider, a warp clock (sleeps advance virtual time instantly,
 * so a 10-minute outage takes milliseconds), and optional SIGKILL at a chosen phase.
 *
 * Env: OMNEXX_TEST_SCENARIO (see scenarios below), OMNEXX_TEST_KILL="<phase>:<cycle>" (SIGKILL
 * there once), OMNEXX_TEST_BOOT_ID, OMNEXX_TEST_OUTAGE_CYCLE=<n> (task n's first turn fails
 * with 529 for 10 virtual minutes), OMNEXX_TEST_TASKS, OMNEXX_TEST_TURN_MS (slow turns). Bundled by test/support/global-setup.ts.
 */
import { appendFileSync } from 'node:fs';
import type { Clock } from '../../src/core/clock.js';
import { runCli } from '../../src/cli/program.js';
import { processIO } from '../../src/cli/io.js';
import { fileWorker, manyTasks, planner, scenario } from './scenarios.js';
import { outage, ScriptedProvider, type Script } from './scripted-provider.js';

let offset = 0;
const warp: Clock = {
  now: () => Date.now() + offset,
  sleep: (ms) => {
    offset += ms;
    return new Promise((r) => setImmediate(r));
  },
};

const tasks = Number(process.env.OMNEXX_TEST_TASKS ?? 6);
const outageCycle = Number(process.env.OMNEXX_TEST_OUTAGE_CYCLE ?? -1);
const outageStart = new Map<string, number>();
const base = scenario(planner(manyTasks(tasks, 5)), fileWorker);
const slow = Number(process.env.OMNEXX_TEST_TURN_MS ?? 0);

const script: Script = (m) => {
  if (outageCycle >= 0 && m.taskId && !m.planner && m.turn === 0) {
    const key = m.taskId;
    // Task number across milestones of 5: M2.T03 is task 8.
    const index =
      Number(/T(\d+)/.exec(m.taskId)?.[1] ?? 0) +
      (Number(/M(\d+)/.exec(m.taskId)?.[1] ?? 1) - 1) * 5;
    if (index === outageCycle) {
      const start = outageStart.get(key) ?? warp.now();
      outageStart.set(key, start);
      if (warp.now() - start < 10 * 60_000) return outage();
    }
  }
  return base(m);
};

const provider = new ScriptedProvider(script);
const slowProvider = slow
  ? {
      name: 'slow',
      complete: async (r: Parameters<typeof provider.complete>[0]) => {
        await new Promise((res) => setTimeout(res, slow));
        return provider.complete(r);
      },
    }
  : provider;

const kill = process.env.OMNEXX_TEST_KILL;
const io = processIO();
io.makeProvider = () => slowProvider;
io.clock = warp;
io.fetch = () => Promise.reject(new Error('no network in tests'));
io.entry = [process.execPath, process.argv[1] ?? ''];
io.supervise = {
  bootId: process.env.OMNEXX_TEST_BOOT_ID ?? 'boot-test',
  heartbeatMs: 100,
  controlPollMs: 50,
  pausePollMs: 50,
};
if (kill) {
  const [phase, cycle] = kill.split(':');
  io.hooks = {
    onPhase: (p, c) => {
      if (p === phase && String(c) === cycle) {
        if (process.env.OMNEXX_TEST_KILL_LOG)
          appendFileSync(process.env.OMNEXX_TEST_KILL_LOG, `${p}:${c}\n`);
        process.kill(process.pid, 'SIGKILL');
      }
    },
  };
}
process.exitCode = await runCli(process.argv.slice(2), io);
