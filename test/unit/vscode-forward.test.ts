import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORWARD } from '../../vscode/src/forward.js';

/** Message types the omnexx chat server handles (`case 'x':` in its command switch). */
async function serverTypes(): Promise<Set<string>> {
  const files = (await readdir('src/cli')).filter((f) => /^chat-.*\.ts$/.test(f));
  const text = (await Promise.all(files.map((f) => readFile(join('src/cli', f), 'utf8')))).join(
    '\n',
  );
  return new Set([...text.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1] ?? ''));
}

/** Message types the panel's webview posts. */
async function postedTypes(): Promise<Set<string>> {
  const dir = 'vscode/src/webview';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
  const text = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
  return new Set(
    [...text.matchAll(/\b(?:post|p)\(\{\s*type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1] ?? ''),
  );
}

describe('the VS Code panel forwards what omnexx handles', () => {
  it('forwards every message the webview posts that the chat server understands', async () => {
    const handled = await serverTypes();
    const missing = [...(await postedTypes())].filter((t) => handled.has(t) && !FORWARD.has(t));
    // A missing type is dropped silently: picking a chat model in Settings once did nothing.
    expect(missing).toEqual([]);
  });
});
