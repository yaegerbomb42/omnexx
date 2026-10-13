// Builds the extension: the extension host code, the chat webview, and a bundled copy of the
// omnexx CLI (out/cli) that runs on the editor's own Node, so the extension works right after
// install. Run from vscode/: `node build.mjs`.
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

rmSync(join(here, 'out'), { recursive: true, force: true });

await build({
  entryPoints: [join(here, 'src/extension.ts')],
  outfile: join(here, 'out/extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  define: { __OMNEXX_VERSION__: JSON.stringify(version) },
  minify: true,
});

await build({
  entryPoints: [join(here, 'src/webview/chat.ts')],
  outfile: join(here, 'out/chat.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
});

await build({
  entryPoints: { index: join(root, 'src/cli/index.ts') },
  outdir: join(here, 'out/cli'),
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  // Optional browser engines stay out; the browser tool explains how to add them.
  external: ['playwright-core', 'camoufox-js', 'react-devtools-core'],
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
});

console.log(`built extension + bundled omnexx ${version}`);
