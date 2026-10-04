import { build } from 'tsup';

/** Bundle the test process entry once per test run (projects that spawn real supervisors). */
export default async function setup(): Promise<void> {
  await build({
    entry: { 'process-entry': 'test/support/process-entry.ts' },
    outDir: 'test/.build',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    sourcemap: false,
    clean: true,
    silent: true,
  });
}
