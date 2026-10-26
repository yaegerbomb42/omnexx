import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** This repo's bundled test entry, by absolute path. */
const ENTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '.build', 'process-entry.js');

/** Bundle the test process entry once per test run (projects that spawn real supervisors). */
export default async function setup(): Promise<() => Promise<void>> {
  await build({
    entryPoints: { 'process-entry': 'test/support/process-entry.ts' },
    outdir: 'test/.build',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['node:sqlite'],
    plugins: [
      {
        name: 'mock-react-devtools',
        setup(b) {
          b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: 'react-devtools-core',
            namespace: 'mock-devtools',
          }));
          b.onLoad({ filter: /.*/, namespace: 'mock-devtools' }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
    ],
    sourcemap: false,
    logLevel: 'silent',
  });

  // A test run must never leave a supervisor behind: a leftover means the run-end cleanup
  // (or the test) failed to kill what it started. Kill stragglers, then fail the run and
  // name them, so the leak cannot hide behind a green suite.
  return async () => {
    const leftovers = await findLeftoverSupervisors().catch(() => []);
    if (!leftovers.length) return;
    for (const l of leftovers) {
      try {
        process.kill(l.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const alive = leftovers.filter((l) => {
        try {
          process.kill(l.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (!alive.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const l of leftovers) {
      try {
        process.kill(l.pid, 0);
        process.kill(l.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    const names = leftovers.map((l) => `pid ${l.pid} (${l.args})`).join(', ');
    throw new Error(`orphaned supervisor processes left after the test run: ${names}`);
  };
}

interface Leftover {
  pid: number;
  args: string;
}

/** Processes still running this repo's bundled test entry. Scoped to this checkout's absolute
 * path: other workspaces on the same machine (a parallel crew, the user's own runs) run
 * their own entry and must never be touched. */
async function findLeftoverSupervisors(): Promise<Leftover[]> {
  const ps = await new Promise<string>((resolve) => {
    execFile('ps', ['-eo', 'pid,args'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
  if (!ps) return [];
  const out: Leftover[] = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[2] ?? '';
    if (pid === process.pid) continue;
    if (args.includes(ENTRY_PATH)) out.push({ pid, args: args.trim() });
  }
  return out;
}
