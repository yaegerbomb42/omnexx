import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkerDetection } from '../types.js';

const execFileAsync = promisify(execFile);

export async function detectExecutable(
  binaryName: string,
  explicitPath?: string,
  versionFlag = '--version',
): Promise<WorkerDetection> {
  const cmd = explicitPath ?? binaryName;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [versionFlag], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const versionOutput = (stdout || stderr || '').trim().split('\n')[0] ?? 'unknown';

    // Query help to inspect capability flags
    let capabilities: string[] = [];
    try {
      const helpRes = await execFileAsync(cmd, ['--help'], {
        timeout: 5000,
        encoding: 'utf8',
      });
      const helpText = `${helpRes.stdout} ${helpRes.stderr}`;
      capabilities = extractCapabilities(helpText);
    } catch {
      // Ignore failure querying help
    }

    return {
      installed: true,
      path: cmd,
      version: versionOutput,
      capabilities,
    };
  } catch {
    return {
      installed: false,
      capabilities: [],
    };
  }
}

function extractCapabilities(helpText: string): string[] {
  const caps: string[] = [];
  if (helpText.includes('--json')) caps.push('json');
  if (helpText.includes('--auto-approve') || helpText.includes('--auto')) caps.push('auto-approve');
  if (helpText.includes('--yes-always') || helpText.includes('--yes')) caps.push('yes');
  if (helpText.includes('--output-format')) caps.push('output-format');
  if (helpText.includes('--ephemeral')) caps.push('ephemeral');
  if (helpText.includes('--no-session-persistence')) caps.push('no-session-persistence');
  return caps;
}

/**
 * Checks whether version meets a minimum semver requirement.
 * Format e.g. "1.2.3" vs "1.0.0".
 */
export function meetsMinVersion(actualVersionString: string, minVersionString: string): boolean {
  const semverRegex = /(\d+)\.(\d+)\.?(\d+)?/;
  const actualMatch = semverRegex.exec(actualVersionString);
  const minMatch = semverRegex.exec(minVersionString);
  if (!actualMatch || !minMatch) return true; // Fail soft if version unparseable

  const aMajor = parseInt(actualMatch[1] ?? '0', 10);
  const aMinor = parseInt(actualMatch[2] ?? '0', 10);
  const aPatch = parseInt(actualMatch[3] ?? '0', 10);

  const mMajor = parseInt(minMatch[1] ?? '0', 10);
  const mMinor = parseInt(minMatch[2] ?? '0', 10);
  const mPatch = parseInt(minMatch[3] ?? '0', 10);

  if (aMajor !== mMajor) return aMajor > mMajor;
  if (aMinor !== mMinor) return aMinor > mMinor;
  return aPatch >= mPatch;
}
