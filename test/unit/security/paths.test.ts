import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PolicyError } from '../../../src/errors.js';
import { globToRegExp, matchesAny } from '../../../src/security/glob.js';
import { isInside, isSecretPath, PathJail } from '../../../src/security/paths.js';
import { tempDir } from '../../support/tmp.js';

describe('PathJail', () => {
  it('allows paths inside, including not-yet-existing ones', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'src'));
    const jail = new PathJail(root);
    expect(jail.resolve('src/a.ts', 'write')).toBe(join(root, 'src/a.ts'));
    expect(jail.resolve('./new/dir/file.ts', 'write')).toBe(join(root, 'new/dir/file.ts'));
    expect(jail.relative(join(root, 'src/a.ts'))).toBe('src/a.ts');
  });

  it('refuses traversal, absolute escapes, home and NUL', async () => {
    const root = await tempDir();
    const jail = new PathJail(root);
    for (const p of ['../x', '../../etc/passwd', '/etc/passwd', 'src/../../x', '\0x']) {
      expect(() => jail.resolve(p, 'read'), p).toThrow(PolicyError);
    }
    expect(() => jail.resolve('~/.ssh/id_ed25519', 'read')).toThrow(/denied|outside/);
  });

  it('refuses symlinks that escape, even through a missing tail', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'secret.txt'), 'x');
    await symlink(outside, join(root, 'link'));
    const jail = new PathJail(root);
    expect(() => jail.resolve('link/secret.txt', 'read')).toThrow(/outside/);
    expect(() => jail.resolve('link/new/file', 'write')).toThrow(/outside/);
  });

  it('denies secret-looking files and git internals inside the worktree', async () => {
    const root = await tempDir();
    const jail = new PathJail(root);
    for (const p of [
      '.env',
      '.env.local',
      'config/server.pem',
      'id_ed25519',
      '.git/config',
      '.npmrc',
      'deploy/.ssh/known_hosts',
    ]) {
      expect(() => jail.resolve(p, 'read'), p).toThrow(/denied/);
    }
    expect(jail.resolve('envelope.ts', 'read')).toBe(join(root, 'envelope.ts'));
  });

  it('case tricks: on case-insensitive platforms a differently-cased root still counts as inside', () => {
    if (process.platform === 'darwin')
      expect(isInside('/Users/A/Repo', '/users/a/repo/x')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isSecretPath('.ENV')).toBe(true);
    expect(isSecretPath('.SSH/x')).toBe(true);
  });
});

describe('glob', () => {
  it.each([
    ['.github/**', '.github/workflows/ci.yml', true],
    ['.github/**', 'src/.github/x', false],
    ['*.lock', 'yarn.lock', true],
    ['*.lock', 'deep/dir/Cargo.lock', true],
    ['package-lock.json', 'pkgs/a/package-lock.json', true],
    ['.env*', '.env.production', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/**/*.ts', 'src/a/b.ts', true],
    ['src/**/*.ts', 'src/b.ts', true],
    ['docs/', 'docs/a.md', true],
    ['a?c', 'abc', true],
    ['a.b', 'axb', false],
  ])('%s vs %s', (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });
  it('matchesAny returns the matching pattern', () => {
    expect(matchesAny('x/omnexx.toml', ['nope', 'omnexx.toml'])).toBe('omnexx.toml');
    expect(matchesAny('a', ['b'])).toBeUndefined();
  });
});
