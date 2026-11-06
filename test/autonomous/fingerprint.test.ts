/**
 * Fingerprint tests (`src/autonomous/fingerprint.ts`).
 *
 * A fingerprint identifies a finding by collector + rule/test id (volatile
 * line numbers stripped) + canonical symbol + the git blob SHAs of its
 * target files. Same finding → same fingerprint; a changed blob SHA (an
 * external edit) → a different fingerprint, which is what lets a tombstone
 * lift when the code it failed against is no longer the code on disk.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blobsChanged,
  canonicalFingerprintInput,
  canonicalSymbol,
  captureBlobHashes,
  computeTaskFingerprint,
  stripVolatileSegments,
  type FindingIdentity,
} from '../../src/autonomous/fingerprint.js';
import { git } from '../../src/git/git.js';
import { tempRepo } from '../support/tmp.js';

async function repoWithFiles(): Promise<string> {
  const root = await tempRepo();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src/adder.ts'),
    'export const add = (a: number, b: number): number => a + b;\n',
  );
  await writeFile(join(root, 'src/other.ts'), 'export const x = 1;\n');
  return root;
}

const finding = (over: Partial<FindingIdentity> = {}): FindingIdentity => ({
  collector: 'test-runner',
  ruleOrTestId: 'adder adds',
  symbol: 'add',
  targetFiles: ['src/adder.ts'],
  ...over,
});

describe('stripVolatileSegments', () => {
  it('strips trailing :line and :line:col suffixes', () => {
    expect(stripVolatileSegments('src/adder.test.ts:12')).toBe('src/adder.test.ts');
    expect(stripVolatileSegments('src/adder.test.ts:12:3')).toBe('src/adder.test.ts');
    expect(stripVolatileSegments('no-unused-vars:7')).toBe('no-unused-vars');
    expect(stripVolatileSegments('suite > test name')).toBe('suite > test name');
  });

  it('strips (line N) markers and #L / :L anchors', () => {
    expect(stripVolatileSegments('adder adds (line 12)')).toBe('adder adds');
    expect(stripVolatileSegments('adder adds (lines 12-14)')).toBe('adder adds');
    expect(stripVolatileSegments('src/adder.ts#L123')).toBe('src/adder.ts');
    expect(stripVolatileSegments('src/adder.ts:L123-L130')).toBe('src/adder.ts');
    expect(stripVolatileSegments('plain-id')).toBe('plain-id');
  });
});

describe('canonicalSymbol', () => {
  it('trims and collapses whitespace; undefined becomes empty', () => {
    expect(canonicalSymbol('  add   ( a,  b ) ')).toBe('add ( a, b )');
    expect(canonicalSymbol(undefined)).toBe('');
  });
});

describe('computeTaskFingerprint', () => {
  it('same finding → same fingerprint (deterministic, 64-char hex)', async () => {
    const root = await repoWithFiles();
    const a = computeTaskFingerprint(finding(), root);
    const b = computeTaskFingerprint(finding(), root);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changed blob SHA → different fingerprint', async () => {
    const root = await repoWithFiles();
    const before = computeTaskFingerprint(finding(), root);
    await writeFile(
      join(root, 'src/adder.ts'),
      'export const add = (a: number, b: number): number => a - b;\n',
    );
    const after = computeTaskFingerprint(finding(), root);
    expect(after).not.toBe(before);
  });

  it('line-number stripping normalizes ids: :12 and :87 fingerprint identically', async () => {
    const root = await repoWithFiles();
    const at12 = computeTaskFingerprint(finding({ ruleOrTestId: 'adder adds:12' }), root);
    const at87 = computeTaskFingerprint(finding({ ruleOrTestId: 'adder adds:87' }), root);
    const at12col = computeTaskFingerprint(finding({ ruleOrTestId: 'adder adds:12:4' }), root);
    expect(at12).toBe(at87);
    expect(at12).toBe(at12col);
  });

  it('different file, collector, rule, or symbol → different fingerprint', async () => {
    const root = await repoWithFiles();
    const base = computeTaskFingerprint(finding(), root);
    expect(computeTaskFingerprint(finding({ targetFiles: ['src/other.ts'] }), root)).not.toBe(base);
    expect(computeTaskFingerprint(finding({ collector: 'typecheck' }), root)).not.toBe(base);
    expect(computeTaskFingerprint(finding({ ruleOrTestId: 'adder subtracts' }), root)).not.toBe(
      base,
    );
    expect(computeTaskFingerprint(finding({ symbol: 'subtract' }), root)).not.toBe(base);
    // Target-file order does not matter (canonical input sorts them).
    const two = computeTaskFingerprint(
      finding({ targetFiles: ['src/adder.ts', 'src/other.ts'] }),
      root,
    );
    const twoSwapped = computeTaskFingerprint(
      finding({ targetFiles: ['src/other.ts', 'src/adder.ts'] }),
      root,
    );
    expect(two).toBe(twoSwapped);
  });
});

describe('captureBlobHashes / blobsChanged', () => {
  it('captureBlobHashes matches `git hash-object` and skips missing files', async () => {
    const root = await repoWithFiles();
    const hashes = captureBlobHashes(root, ['src/adder.ts', 'src/other.ts', 'src/missing.ts']);
    expect(hashes.size).toBe(2);
    const expected = (await git(root, ['hash-object', '--', 'src/adder.ts'])).stdout.trim();
    expect(hashes.get('src/adder.ts')).toBe(expected);
    expect(captureBlobHashes(root, []).size).toBe(0);
  });

  it('canonicalFingerprintInput sorts files so map order is irrelevant', () => {
    const a = canonicalFingerprintInput(
      finding(),
      new Map([
        ['b.ts', 'sha-b'],
        ['a.ts', 'sha-a'],
      ]),
    );
    const b = canonicalFingerprintInput(
      finding(),
      new Map([
        ['a.ts', 'sha-a'],
        ['b.ts', 'sha-b'],
      ]),
    );
    expect(a).toBe(b);
    expect(a).toContain('a.ts=sha-a,b.ts=sha-b');
  });

  it('blobsChanged detects edits and deletions, passes unchanged files', async () => {
    const root = await repoWithFiles();
    const hashes = captureBlobHashes(root, ['src/adder.ts']);
    const recorded: Record<string, string> = {};
    for (const [file, sha] of hashes) recorded[file] = sha;

    expect(blobsChanged(root, 'fp', recorded)).toEqual({
      changed: false,
      changedFiles: [],
      fingerprint: 'fp',
    });
    await writeFile(join(root, 'src/adder.ts'), 'export const add = (): number => 0;\n');
    const edited = blobsChanged(root, 'fp', recorded);
    expect(edited.changed).toBe(true);
    expect(edited.changedFiles).toEqual(['src/adder.ts']);
    await rm(join(root, 'src/adder.ts'));
    expect(blobsChanged(root, 'fp', recorded).changed).toBe(true);
    expect(blobsChanged(root, 'fp', {}).changed).toBe(false);
  });
});
