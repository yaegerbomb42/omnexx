import { PassThrough, Readable } from 'node:stream';
import type { CliIO } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return () => Buffer.concat(chunks).toString('utf8');
}

export async function cli(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): Promise<CliRun> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const io: CliIO = {
    stdout,
    stderr,
    stdin: Readable.from(opts.stdin === undefined ? [] : [opts.stdin]),
    env: opts.env,
    cwd: opts.cwd,
    isTTY: false,
  };
  const code = await runCli(argv, io);
  return { code, stdout: out(), stderr: err() };
}
