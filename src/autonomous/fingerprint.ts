/**
 * Content-addressed task fingerprints for the autonomous daemon.
 *
 * A fingerprint identifies a unit of work by *what* it is about, not by when
 * it was found: collector + rule/test id + canonical symbol + the git blob
 * SHAs of every target file. The same finding rediscovered later (or after a
 * daemon restart) produces the same fingerprint, so the done-set and the
 * tombstone registry can deduplicate it without any in-memory state.
 *
 * Blob SHAs are part of the identity on purpose: if a human (or another
 * agent) edits a target file, the fingerprint for the same rule changes, so
 * a previously tombstoned task can be legitimately retried against the new
 * content instead of being suppressed forever. `blobsChanged` is the check
 * that detects that external invalidation.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export interface FindingIdentity {
  /** Which collector produced the finding (e.g. 'test-runner', 'typecheck'). */
  collector: string;
  /**
   * Rule or test id, e.g. 'no-unused-vars' or 'suite > test name'.
   * May contain volatile line/column suffixes; they are stripped.
   */
  ruleOrTestId: string;
  /** Canonical symbol the finding is about, if any (function/class name). */
  symbol?: string;
  /** Target files, relative to the repo root. */
  targetFiles: readonly string[];
}

/**
 * Strip volatile segments from a rule/test id so the fingerprint is stable
 * across runs: trailing `:line:col` / `:line` suffixes, `(line N)` markers,
 * and `#L123` / `:L123` anchors.
 */
export function stripVolatileSegments(id: string): string {
  return (
    id
      // `path/to/file.ts:12:3` or `rule:12:3` -> drop trailing numeric segments
      .replace(/:\d+(?::\d+)?$/, '')
      // `... (line 12)` / `... (lines 12-14)`
      .replace(/\s*\(lines?\s+\d+(?:\s*-\s*\d+)?\)\s*$/i, '')
      // `#L123`, `:L123`
      .replace(/[#:]L\d+(?:-L\d+)?$/i, '')
      .trim()
  );
}

/** Normalise a symbol for fingerprinting: trim and collapse whitespace. */
export function canonicalSymbol(symbol: string | undefined): string {
  if (symbol === undefined) return '';
  return symbol.trim().replace(/\s+/g, ' ');
}

/**
 * Hash the working-tree contents of each file with `git hash-object`, the
 * same blob SHA git itself would assign. Files that do not exist (deleted
 * since the finding was recorded) are skipped. Returns a map of the file
 * path as given to its 40-char blob SHA.
 */
export function captureBlobHashes(repoRoot: string, files: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  const unique = [...new Set(files)].filter((f) => f.length > 0);
  if (unique.length === 0) return hashes;
  const result = spawnSync('git', ['hash-object', '--stdin-paths'], {
    cwd: repoRoot,
    input: unique.join('\n'),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // Fall back to per-file hashing so one missing file does not lose the rest.
    for (const file of unique) {
      const single = spawnSync('git', ['hash-object', '--', file], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (single.status === 0) hashes.set(file, single.stdout.trim());
    }
    return hashes;
  }
  const lines = result.stdout.split('\n');
  for (let i = 0; i < unique.length; i++) {
    const sha = lines[i]?.trim();
    const file = unique[i];
    if (sha !== undefined && sha !== '' && file !== undefined) hashes.set(file, sha);
  }
  return hashes;
}

/** Canonical pre-image string for a fingerprint. Exported for tests/debug. */
export function canonicalFingerprintInput(
  finding: FindingIdentity,
  blobHashes: ReadonlyMap<string, string>,
): string {
  const filesPart = [...blobHashes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, sha]) => `${file}=${sha}`)
    .join(',');
  return (
    `${finding.collector}:${stripVolatileSegments(finding.ruleOrTestId)}:` +
    `${canonicalSymbol(finding.symbol)}|${filesPart}`
  );
}

/**
 * SHA-256 fingerprint of a finding:
 * `${collector}:${ruleOrTestId}:${canonicalSymbol}|${sorted targetFiles with their git blob SHAs}`.
 * Volatile line numbers are stripped from the rule/test id first, so the
 * same finding at a shifted line number fingerprints identically.
 */
export function computeTaskFingerprint(finding: FindingIdentity, repoRoot: string): string {
  const blobHashes = captureBlobHashes(repoRoot, finding.targetFiles);
  const input = canonicalFingerprintInput(finding, blobHashes);
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Detect external invalidation: compare the current blob SHAs of the files
 * recorded for a fingerprint against the hashes captured when the task was
 * first seen. Returns true when any recorded file changed content, was
 * deleted, or is otherwise no longer at the recorded blob.
 *
 * Note on the signature: a SHA-256 digest alone cannot recover the file
 * list, so the caller passes the recorded blob map (from
 * `done_set.target_blob_hashes_json` / `tombstone_registry.target_blob_hashes_json`).
 * The `fingerprint` argument identifies which entry is being checked and is
 * echoed in the returned detail for logging; the blob map is the source of
 * truth for the comparison.
 */
export function blobsChanged(
  repoRoot: string,
  fingerprint: string,
  expectedBlobHashes: Readonly<Record<string, string>>,
): { changed: boolean; changedFiles: string[]; fingerprint: string } {
  const files = Object.keys(expectedBlobHashes);
  const changedFiles: string[] = [];
  if (files.length === 0) return { changed: false, changedFiles, fingerprint };
  const current = captureBlobHashes(repoRoot, files);
  for (const file of files) {
    if (current.get(file) !== expectedBlobHashes[file]) changedFiles.push(file);
  }
  return { changed: changedFiles.length > 0, changedFiles, fingerprint };
}
