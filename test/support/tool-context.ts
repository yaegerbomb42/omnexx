import { EventLog } from '../../src/core/events.js';
import { resolvePaths } from '../../src/core/paths.js';
import { RunStore } from '../../src/core/run-store.js';
import { scrubEnv } from '../../src/security/env-scrub.js';
import { PathJail } from '../../src/security/paths.js';
import { Redactor } from '../../src/security/redact.js';
import type { ToolContext } from '../../src/tools/types.js';
import { FakeClock } from './clock.js';
import { isolatedEnv } from './tmp.js';

export async function toolContext(
  root: string,
  over: Partial<ToolContext> = {},
): Promise<ToolContext> {
  const env = await isolatedEnv();
  const store = new RunStore(resolvePaths(env), 'r_20261003_0000_test');
  await store.init();
  let n = 0;
  return {
    jail: new PathJail(root),
    env: scrubEnv(process.env),
    store,
    events: new EventLog(store.eventsPath, store.runId, new Redactor(), new FakeClock()),
    redactor: new Redactor(),
    policy: { root, home: '/home/nobody', allowNetwork: false, extraDeny: [] },
    cycle: 1,
    maxCmdTimeoutMs: 10_000,
    notesMaxTokens: 1_500,
    today: '2026-10-03',
    nextCommandId: () => `cmd-1-${++n}`,
    edited: new Set(),
    ...over,
  };
}
