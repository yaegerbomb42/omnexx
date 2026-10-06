import { execa } from 'execa';
import type { BrowserBackend, BackendDetectResult } from './types.js';
import { AgentBrowserBackend } from './agent-browser.js';
import { PlaywrightBackend } from './playwright.js';

let cachedDetection: BackendDetectResult | null = null;

export async function detectBrowserBackend(): Promise<BackendDetectResult> {
  if (cachedDetection) {
    return cachedDetection;
  }

  // 1. Check for agent-browser on PATH
  try {
    const result = await execa('agent-browser', ['--version'], {
      reject: false,
      timeout: 3_000,
      stdin: 'ignore',
    });
    if (!result.failed) {
      const version = result.stdout.split('\n')[0]?.trim() ?? '';
      cachedDetection = {
        backend: 'agent-browser',
        detail: `agent-browser ${version} found on PATH`,
      };
      return cachedDetection;
    }
  } catch {
    // Not found or failed
  }

  // 2. Check for playwright-core
  try {
    // @ts-expect-error dynamic import of optional peer dependency
    const pw: unknown = await import('playwright-core');
    if (pw !== null && pw !== undefined) {
      cachedDetection = {
        backend: 'playwright',
        detail: 'playwright-core available',
      };
      return cachedDetection;
    }
  } catch {
    // Not installed
  }

  cachedDetection = {
    backend: null,
    detail: 'neither agent-browser CLI nor playwright-core available',
  };
  return cachedDetection;
}

export function resetDetectionCache(): void {
  cachedDetection = null;
}

export async function createBrowserBackend(
  session: string,
  headless = true,
): Promise<BrowserBackend | null> {
  const detected = await detectBrowserBackend();
  if (detected.backend === 'agent-browser') {
    return new AgentBrowserBackend(session, headless);
  }
  if (detected.backend === 'playwright') {
    return new PlaywrightBackend(headless);
  }
  return null;
}

export interface DoctorCheckResult {
  name: string;
  status: 'ok' | 'warn';
  detail: string;
}

export async function browserDoctorCheck(): Promise<DoctorCheckResult> {
  const detected = await detectBrowserBackend();
  if (detected.backend) {
    return {
      name: 'browser backend',
      status: 'ok',
      detail: `${detected.backend} (${detected.detail})`,
    };
  }
  return {
    name: 'browser backend',
    status: 'warn',
    detail:
      'no browser backend found; install `agent-browser` or `playwright-core` to enable browser tool and gates',
  };
}
