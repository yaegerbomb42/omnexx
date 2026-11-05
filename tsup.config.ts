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
  external: ['node:sqlite', 'sqlite'],
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
