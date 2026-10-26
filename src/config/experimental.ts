import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { resolvePaths, userConfigFile } from '../core/paths.js';

/**
 * The one gate for everything that is not the default experience: extra modes, presets,
 * experiments and the extra CLI commands. On by default nowhere; turned on by any of:
 *
 * - the `--experimental` CLI flag (or `OMNEXX_EXPERIMENTAL=1` in the environment), or
 * - `experimental = true` in the user config file (`~/.config/omnexx/config.toml`).
 *
 * Nothing else reads the flag: code behind it keeps working, it just leaves the default
 * help, the default settings page and the default first-run flow.
 */
export function isExperimentalEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OMNEXX_EXPERIMENTAL;
  return raw === '1' || raw?.toLowerCase() === 'true' || raw?.toLowerCase() === 'yes';
}

export function experimentalInArgv(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--experimental' || a.startsWith('--experimental='));
}

/** `experimental = true` at the top level of the user config file, if it parses. */
export function experimentalInUserConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const text = readFileSync(userConfigFile(resolvePaths(env)), 'utf8');
    return (parseToml(text) as Record<string, unknown>).experimental === true;
  } catch {
    return false;
  }
}

export function isExperimental(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return experimentalInArgv(argv) || isExperimentalEnv(env) || experimentalInUserConfig(env);
}
