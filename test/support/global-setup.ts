import { build } from 'esbuild';

/** Bundle the test process entry once per test run (projects that spawn real supervisors). */
export default async function setup(): Promise<void> {
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
}
