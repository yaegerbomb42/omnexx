/**
 * `omnexx system1` (alias `omnexx jev`): the active System-1 backend and per-gate telemetry from
 * the latest run (or `--run <id>`); `omnexx system1 eval "<command or prompt>"` (or `--check`)
 * runs a live self-check of the noul / choice / score primitives and prints calibrated
 * probabilities with latency.
 */
import pc from 'picocolors';
import { join } from 'node:path';
import { loadConfig } from '../../config/load.js';
import { readEvents } from '../../core/events.js';
import { resolvePaths, runDir } from '../../core/paths.js';
import { systemOneClient, systemOneApiKey } from '../../runtime/system-one/index.js';
import type { SystemOneClient } from '../../runtime/system-one/client.js';
import { assessCommand } from '../../runtime/system-one/guardrail.js';
import { classifyIntent } from '../../runtime/system-one/intent-router.js';
import {
  snapshotFromEvents,
  type SystemOneObserveSnapshot,
} from '../../runtime/system-one/observe.js';
import { assessPatch } from '../../runtime/system-one/patch-sanity.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';
import type { CommandRegistrar } from './extra/types.js';
import { latestRunDir } from './usage.js';

const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

const DEFAULT_CHECK = 'git reset --hard HEAD~3 && git push --force';

async function client(io: CliIO): Promise<{
  c: SystemOneClient;
  keySet: boolean;
  enabled: boolean;
  thresholds: { destructive: number; patch: number };
}> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  return {
    c: systemOneClient(config, io.env),
    keySet: Boolean(systemOneApiKey(config, io.env)),
    enabled: config.system_one.enabled,
    thresholds: {
      destructive: config.system_one.destructive_threshold,
      patch: config.system_one.patch_placeholder_threshold,
    },
  };
}

function printSnapshot(io: CliIO, snap: SystemOneObserveSnapshot): void {
  const line = (label: string, value: string): void => {
    println(io.stdout, `  ${label.padEnd(18)} ${value}`);
  };
  if (snap.intent) line('last intent', `${snap.intent.label} · ${pct(snap.intent.confidence)}`);
  line(
    'guardrail',
    `${String(snap.guardrail.checked)} checked · ${String(snap.guardrail.intercepted)} intercepted`,
  );
  line(
    'patch sanity',
    `${String(snap.patch.checked)} checked · ${String(snap.patch.caught)} lazy patches caught`,
  );
  line(
    'output triage',
    `${String(snap.triage.runs)} runs · ${k(snap.triage.linesPruned)} lines · ${k(snap.triage.tokensSaved)} tokens pruned`,
  );
  line('speculative', `${String(snap.speculative.hits)} pre-fetch hits`);
  line(
    'early stop',
    `${String(snap.earlyStop.turnsSaved)} turns · ${k(snap.earlyStop.tokensSaved)} tokens saved`,
  );
  line(
    'total saved',
    `~${k(snap.tokensSaved)} frontier tokens · p50 ${snap.latencyP50Ms.toFixed(2)}ms per check`,
  );
}

export async function system1Status(
  io: CliIO,
  opts: { run?: string; json?: boolean },
): Promise<number> {
  const { c, keySet, enabled } = await client(io);
  const p = resolvePaths(io.env);
  const dir = opts.run ? runDir(p, opts.run) : await latestRunDir(p);
  const snap = dir ? snapshotFromEvents(await readEvents(join(dir, 'events.jsonl'))) : null;
  const backend = {
    label: await c.probeLabel(),
    primary: c.primary,
    model: c.model,
    apiKey: keySet ? 'set' : 'unset',
    enabled,
  };
  if (opts.json) {
    println(io.stdout, JSON.stringify({ run: dir ?? null, backend, telemetry: snap }, null, 2));
    return EXIT.ok;
  }
  println(io.stdout, pc.bold('System-1'));
  const disabledTag = enabled ? '' : pc.yellow(' · disabled');
  println(
    io.stdout,
    `  backend ${pc.magenta(backend.label)} · ${backend.primary}${disabledTag} · key ${backend.apiKey}`,
  );
  if (!snap) println(io.stdout, pc.dim('  no system1 events' + (dir ? ' in ' + dir : '')));
  else printSnapshot(io, snap);
  return EXIT.ok;
}

/** Live self-check: each primitive once on the input, with calibrated probabilities and latency. */
export async function system1Eval(
  io: CliIO,
  input: string | undefined,
  opts: { json?: boolean },
): Promise<number> {
  const { c, thresholds } = await client(io);
  const trimmed = input?.trim();
  const text = trimmed?.length ? trimmed : DEFAULT_CHECK;
  const guard = await assessCommand(
    c,
    { command: text, cwd: io.cwd, repoRoot: io.cwd, allowOutsideRepo: false },
    thresholds.destructive,
  );
  const intent = await classifyIntent(c, text);
  const patch = await assessPatch(
    c,
    {
      path: 'example.ts',
      oldText: 'function f() {\n  const a = 1;\n  return a + 1;\n}',
      newText: `function f() {\n  ${text.split('\n')[0] ?? ''}\n}`,
    },
    thresholds.patch,
  );
  const result = {
    backend: c.label(),
    noul: {
      question: 'destructive?',
      prob: guard.prob,
      destructive: guard.destructive,
      backend: guard.backend,
      latencyMs: guard.latencyMs,
    },
    choice: {
      question: 'intent',
      choice: intent.intent,
      probabilities: intent.probabilities,
      backend: intent.backend,
      latencyMs: intent.latencyMs,
    },
    score: {
      question: 'diff completeness (input as the new body)',
      score: patch.completeness,
      confidence: patch.confidence,
      backend: patch.backend,
      latencyMs: patch.latencyMs,
    },
  };
  if (opts.json) {
    println(io.stdout, JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  const ms = (n: number): string => `${n.toFixed(2)}ms`;
  const verdict = guard.destructive ? pc.red(' → would intercept') : pc.green(' → passes');
  println(io.stdout, pc.bold(`System-1 self-check · ${result.backend}`));
  const shown = text.length > 100 ? text.slice(0, 97) + '...' : text;
  println(io.stdout, `  input   ${pc.dim(shown)}`);
  println(
    io.stdout,
    `  noul    destructive prob ${pct(guard.prob)}${verdict} · ${guard.backend} · ${ms(guard.latencyMs)}`,
  );
  const probs = Object.entries(intent.probabilities)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, v]) => `${key} ${pct(v)}`)
    .join(' · ');
  println(
    io.stdout,
    `  choice  ${pc.magenta(intent.intent)} (${probs}) · ${intent.backend} · ${ms(intent.latencyMs)}`,
  );
  println(
    io.stdout,
    `  score   completeness ${String(patch.completeness)}/5 (confidence ${pct(patch.confidence)}) · ${patch.backend} · ${ms(patch.latencyMs)}`,
  );
  return EXIT.ok;
}

export const register: CommandRegistrar = (program, io, setExit) => {
  const cmd = program
    .command('system1')
    .alias('jev')
    .option('--run <id>', 'a specific run (defaults to the latest)')
    .option('--json', 'machine-readable output')
    .option('--check [input]', 'run a live System-1 self-check (same as `system1 eval`)')
    .description('System-1 (Jev) gates: active backend, per-gate telemetry, live self-check')
    .action(async (opts: { run?: string; json?: boolean; check?: string | boolean }) => {
      if (opts.check !== undefined)
        setExit(
          await system1Eval(io, typeof opts.check === 'string' ? opts.check : undefined, opts),
        );
      else setExit(await system1Status(io, opts));
    });
  cmd
    .command('eval [input]')
    .option('--json', 'machine-readable output')
    .description('live self-check of noul / choice / score on a command or prompt')
    .action(async (input: string | undefined, opts: { json?: boolean }) => {
      setExit(await system1Eval(io, input, opts));
    });
};
