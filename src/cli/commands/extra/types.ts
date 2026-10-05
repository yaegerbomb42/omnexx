import type { Command } from 'commander';
import type { CliIO } from '../../io.js';

/** Adds one top-level command (with any subcommands) to the program. */
export type CommandRegistrar = (
  program: Command,
  io: CliIO,
  setExit: (code: number) => void,
) => void;
