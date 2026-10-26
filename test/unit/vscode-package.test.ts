import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('vscode/package.json keybindings', () => {
  it('every keybinding references a command in contributes.commands', async () => {
    const pkgPath = 'vscode/package.json';
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      contributes: {
        commands: { command: string }[];
        keybindings: { command: string; when?: string }[];
      };
    };
    const commandSet = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const kb of pkg.contributes.keybindings) {
      expect(commandSet.has(kb.command)).toBe(true);
    }
  });
});
