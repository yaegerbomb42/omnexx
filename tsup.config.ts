import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The TUI (React/Ink) loads in its own chunk, only when the interactive session opens.
  splitting: true,
  banner: { js: '#!/usr/bin/env node' },
});
