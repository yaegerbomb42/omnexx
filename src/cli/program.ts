import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { assertProvider, clearKey, storeKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths } from '../core/paths.js';
import { describeError, UsageError } from '../errors.js';
import {
  requestControl,
  resumeAllCommand,
  resumeRun,
  superviseForeground,
} from './commands/control.js';
import { binaryVersion, renderChecks, runDoctorChecks } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import {
  checkpointsCommand,
  diffCommand,
  logsCommand,
  planCommand,
  reportCommand,
  runsCommand,
  statusCommand,
} from './commands/inspect.js';
import { readGoal, runCommand, runPlanOnly, type FullRunFlags } from './commands/run.js';
import * as extraCommands from './commands/extra/index.js';
import type { CommandRegistrar } from './commands/extra/types.js';
import { serviceCommand } from './commands/service.js';
import { dockerAvailable } from '../security/sandbox-docker.js';
import { banner, brand } from './brand.js';
import { EXIT } from './exit-codes.js';
import { verbosityFrom } from '../telemetry/humanize.js';
import { println, readSecret, type CliIO } from './io.js';

export const VERSION: string = pkg.version;
const EXTRA_COMMANDS: Record<string, CommandRegistrar> = extraCommands;

/** Build the commander program. Actions report their exit code through `setExit`. */
export function createProgram(io: CliIO, setExit: (code: number) => void): Command {
  const program = new Command('omnexx')
    .description('Set a goal, walk away, come back to commits.')
    .version(VERSION, '-v, --version')
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .exitOverride()
    .showHelpAfterError('(run `omnexx --help` for usage)');

  // Brand the help screen on a terminal; piped output stays plain for scripts.
  const b = brand(io);
  const columns = (io.stdout as { columns?: number }).columns ?? 80;
  if (io.isTTY) program.addHelpText('beforeAll', banner(io, columns, VERSION));
  program.configureHelp({
    styleTitle: (s) => b.green(s),
    styleCommandText: (s) => b.cyan(s),
    styleSubcommandText: (s) => b.cyan(s),
    styleOptionText: (s) => b.cyan(s),
    styleArgumentText: (s) => b.dim(s),
  });
  // Bare `omnexx`: the interactive session on a terminal, help otherwise.
  program.option('--no-tui', 'print help instead of opening the interactive session');
  program.option('-c, --continue', 'continue the last chat in this folder');
  program.action(async (opts: { tui: boolean; continue?: boolean }) => {
    if (!io.isTTY || !opts.tui || io.env.TERM === 'dumb') {
      program.outputHelp();
      return;
    }
    const { startTui } = await import('../tui/start.js');
    setExit(
      await startTui(io, runCli, {
        version: VERSION,
        ...(opts.continue ? { continueChat: true } : {}),
      }),
    );
  });

  program
    .command('watch')
    .alias('attach')
    .argument('[runId]', 'defaults to the most recent run')
    .description('open the interactive session attached to a run')
    .action(async (runId: string | undefined) => {
      if (!io.isTTY) throw new UsageError('watch needs a terminal', 'use `omnexx logs -f` instead');
      const { startTui } = await import('../tui/start.js');
      setExit(await startTui(io, runCli, { version: VERSION, attach: runId ?? true }));
    });

  program
    .command('init')
    .description('detect package manager and gates, then write omnexx.toml (asks first)')
    .option('-y, --yes', 'write without asking')
    .action(async (opts: { yes?: boolean }) => {
      await runInit(io, { yes: opts.yes === true });
    });

  program
    .command('run')
    .description(
      'start a run on this repo: plan, then cycle until done, stuck, stopped or out of budget',
    )
    .argument('[goal]', 'what to achieve (or use --goal-file)')
    .option('--goal-file <path>', 'read the goal from a file (e.g. SPEC.md)')
    .option('--detach', 'run the supervisor in the background and return')
    .option('--plan-only', 'run the planner, print the plan, and stop')
    .option('--budget <usd>', 'run-level spend cap in USD')
    .option('--hours <n>', 'wall-clock cap in hours')
    .option(
      '--gate <command>',
      'gate command (repeatable)',
      (v: string, prev: string[] | undefined) => [...(prev ?? []), v],
    )
    .option('--sandbox <mode>', 'host | docker')
    .option('--model-worker <alias>', 'worker model alias, e.g. sonnet')
    .option('--push <mode>', 'none | branch')
    .option('--from <ref>', 'branch the run from this ref (default HEAD)')
    .option('--i-know-there-are-no-checks', 'allow a run without gates (limited to one cycle)')
    .option('-q, --quiet', 'feed: only commits, verdicts and stops')
    .option('--verbose', 'feed: every model turn and tool call')
    .option('--debug', 'feed: every raw event')
    .action(async (goal: string | undefined, opts: FullRunFlags) => {
      const text = await readGoal(io, goal, opts.goalFile);
      setExit(opts.planOnly ? await runPlanOnly(io, text, opts) : await runCommand(io, text, opts));
    });

  program
    .command('supervise', { hidden: true })
    .argument('<runId>')
    .description('run the supervisor for one run in the foreground (used by --detach and services)')
    .action(async (runId: string) => {
      setExit(await superviseForeground(io, runId));
    });

  program
    .command('status')
    .argument('[runId]', 'defaults to the most recent run')
    .option('--json', 'machine-readable output')
    .description('phase, cycle, task, progress, spend, heartbeat')
    .action(async (runId: string | undefined, opts: { json?: boolean }) => {
      setExit(await statusCommand(io, runId, opts.json === true));
    });

  program
    .command('logs')
    .argument('[runId]')
    .option('-f, --follow', 'keep streaming until the run ends')
    .option('--events', 'raw JSONL events')
    .option('--progress', 'the progress journal')
    .option('--cmd <id>', 'a full command or gate log, e.g. cmd-3-1')
    .option('-q, --quiet', 'only commits, verdicts and stops')
    .option('--verbose', 'every model turn and tool call')
    .option('--debug', 'every raw event')
    .description('live feed of what the agent is doing (-f to follow)')
    .action(
      async (
        runId: string | undefined,
        opts: {
          follow?: boolean;
          events?: boolean;
          progress?: boolean;
          cmd?: string;
          quiet?: boolean;
          verbose?: boolean;
          debug?: boolean;
        },
      ) => {
        setExit(await logsCommand(io, runId, { ...opts, verbosity: verbosityFrom(opts) }));
      },
    );

  program
    .command('plan')
    .argument('[runId]')
    .option('--edit', 'edit goal.md in $EDITOR; picked up next cycle')
    .description('show the plan')
    .action(async (runId: string | undefined, opts: { edit?: boolean }) => {
      setExit(await planCommand(io, runId, opts.edit === true));
    });

  program
    .command('pause')
    .argument('[runId]')
    .description('pause at the next turn boundary')
    .action(async (runId: string | undefined) => {
      setExit(await requestControl(io, runId, 'pause'));
    });

  program
    .command('resume')
    .argument('[runId]')
    .option('--all', 'resume every interrupted run in the foreground (what the service runs)')
    .description('continue a paused or stopped run, or restart a crashed supervisor')
    .action(async (runId: string | undefined, opts: { all?: boolean }) => {
      if (opts.all && runId) throw new UsageError('give a run id or --all, not both');
      setExit(opts.all ? await resumeAllCommand(io) : await resumeRun(io, runId));
    });

  program
    .command('stop')
    .argument('[runId]')
    .option('--now', 'abort the current turn and roll back')
    .description('stop at the next turn boundary (finishing the cycle), or immediately with --now')
    .action(async (runId: string | undefined, opts: { now?: boolean }) => {
      setExit(await requestControl(io, runId, opts.now ? 'stop-now' : 'stop'));
    });

  program
    .command('runs')
    .description('list runs')
    .action(async () => {
      setExit(await runsCommand(io));
    });

  program
    .command('diff')
    .argument('[runId]')
    .option('--since <milestoneId>', 'diff from a milestone checkpoint')
    .description('git diff from the start (or a checkpoint) to lastGreen')
    .action(async (runId: string | undefined, opts: { since?: string }) => {
      setExit(await diffCommand(io, runId, opts.since));
    });

  program
    .command('checkpoints')
    .argument('[runId]')
    .description('milestone checkpoints: commit, time, tests, spend')
    .action(async (runId: string | undefined) => {
      setExit(await checkpointsCommand(io, runId));
    });

  program
    .command('report')
    .argument('[runId]')
    .description('write and print the morning-after REPORT.md')
    .action(async (runId: string | undefined) => {
      setExit(await reportCommand(io, runId));
    });

  program
    .command('service')
    .argument('<action>', 'install | uninstall | status')
    .option('--dry-run', 'print the unit file instead of installing it')
    .description(
      'systemd user unit (Linux) or launchd agent (macOS) that resumes runs after reboot',
    )
    .action(async (action: string, opts: { dryRun?: boolean }) => {
      setExit(await serviceCommand(io, action, opts.dryRun === true));
    });

  program
    .command('doctor')
    .description('check node, git, rg, the API key (masked), network and the optional judge')
    .option('--offline', 'skip network checks')
    .option('--json', 'machine-readable output')
    .action(async (opts: { offline?: boolean; json?: boolean }) => {
      const paths = resolvePaths(io.env);
      const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
      const checks = await runDoctorChecks({
        env: io.env,
        paths,
        config,
        offline: opts.offline === true,
        nodeVersion: process.version,
        versionOf: binaryVersion,
        fetch: globalThis.fetch,
        now: Date.now,
        dockerReady: () => dockerAvailable(io.env),
      });
      if (opts.json) println(io.stdout, JSON.stringify({ checks }, null, 2));
      else renderChecks(io, checks);
      if (checks.some((c) => c.status === 'fail')) setExit(EXIT.error);
    });

  const auth = program.command('auth').description('store or clear a provider API key (0600 file)');
  auth
    .command('set <provider>')
    .description('read the key from stdin without echo and store it')
    .action(async (provider: string) => {
      const p = assertProvider(provider);
      const key = await readSecret(io, `Paste your ${p} API key: `);
      if (!key?.trim()) throw new UsageError('no key entered', 'nothing was stored');
      const file = await storeKey(resolvePaths(io.env), p, key);
      println(io.stdout, `Stored in ${file} (mode 0600).`);
    });
  auth
    .command('clear <provider>')
    .description('delete the stored key')
    .action(async (provider: string) => {
      const removed = await clearKey(resolvePaths(io.env), assertProvider(provider));
      println(io.stdout, removed ? 'Stored key removed.' : 'No stored key.');
    });

  for (const [, register] of Object.entries(EXTRA_COMMANDS).sort(([a], [b]) => (a < b ? -1 : 1))) {
    register(program, io, setExit);
  }

  return program;
}

/** Parse argv, run the command, and return the exit code. Never throws. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  let code: number = EXIT.ok;
  const program = createProgram(io, (c) => {
    code = c;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 ? EXIT.ok : EXIT.error;
    }
    println(io.stderr, describeError(err));
    return EXIT.error;
  }
}
