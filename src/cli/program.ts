import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { assertProvider, clearKey, storeKey } from '../auth/keys.js';
import { loadConfig } from '../config/load.js';
import { resolvePaths } from '../core/paths.js';
import { describeError, UsageError } from '../errors.js';
import { binaryVersion, renderChecks, runDoctorChecks } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { EXIT } from './exit-codes.js';
import { println, readSecret, type CliIO } from './io.js';

export const VERSION: string = pkg.version;

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

  program
    .command('init')
    .description('detect package manager and gates, then write omnexx.toml (asks first)')
    .option('-y, --yes', 'write without asking')
    .action(async (opts: { yes?: boolean }) => {
      await runInit(io, { yes: opts.yes === true });
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
