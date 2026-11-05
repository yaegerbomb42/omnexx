#!/usr/bin/env node
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'runtime', 'kernel', 'data', 'mcp-registry-snapshot.json.gz');
// Single source of truth: src/runtime/kernel/data. Only the build output gets a copy
// (no committed root data/ duplicate that can drift).
const targets = [join(root, 'dist', 'data', 'mcp-registry-snapshot.json.gz')];
if (!existsSync(src)) {
  console.warn('[copy-kernel-data] snapshot missing at', src);
  process.exit(0);
}
for (const t of targets) {
  mkdirSync(dirname(t), { recursive: true });
  copyFileSync(src, t);
  console.log('[copy-kernel-data]', t);
}
