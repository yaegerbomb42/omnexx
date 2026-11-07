import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

const SNAPSHOT = 'mcp-registry-snapshot.json.gz';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Keep the `node:` prefix: listing bare 'sqlite' here makes esbuild rewrite every
  // dynamic `import('node:sqlite')` (query-artifact, the autonomous state store) to
  // `import('sqlite')`, which Node cannot resolve at runtime. Nothing imports bare
  // 'sqlite' as a module.
  // `typescript` is external too: the daemon graph pulls in the TS compiler
  // (ast-analysis), and bundling it breaks at runtime — its CJS body calls
  // `require("fs")` at load, which esbuild's ESM `__require` shim refuses with
  // 'Dynamic require of "fs" is not supported'. NOTE: typescript is currently a
  // devDependency, so the published package would not ship it — it must move to
  // `dependencies` before release for `daemon start` to work when installed.
  external: ['node:sqlite', 'typescript'],
  // tsup strips the `node:` prefix from every builtin import by default
  // (nodeProtocolPlugin), which turns `import('node:sqlite')` into the unresolvable
  // `import('sqlite')` in the built CLI. Node 22+ resolves `node:` specifiers
  // natively, so keep them.
  removeNodeProtocol: false,
  // The TUI (React/Ink) loads in its own chunk, only when the interactive session opens.
  splitting: true,
  banner: { js: '#!/usr/bin/env node' },
  // `clean: true` wipes dist/ — always re-ship the bundled MCP Registry snapshot, even
  // when tsup runs alone (not via `npm run build`).
  onSuccess: () => {
    mkdirSync('dist/data', { recursive: true });
    copyFileSync(`src/runtime/kernel/data/${SNAPSHOT}`, `dist/data/${SNAPSHOT}`);
    return Promise.resolve();
  },
});
