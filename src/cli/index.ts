import { processIO } from './io.js';
import { runCli } from './program.js';

process.exitCode = await runCli(process.argv.slice(2), processIO());
