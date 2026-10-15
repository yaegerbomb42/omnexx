import { createHash } from 'node:crypto';
import type { Note } from './notes.js';

/**
 * A tiny per-repo memory of (error signature -> fix that worked), kept as ordinary lessons
 * (`pitfall` notes tagged with a signature hash), so it rides the existing run notes -> repo
 * memory fold and its size cap. When the same signature fails again, the fix is surfaced.
 */

const TAG = /\[sig:([0-9a-f]{8})\]/;
/** Characters of the signature and of the fix kept in a note (notes cap at 400). */
const SIG_CHARS = 120;
const FIX_CHARS = 220;

export const signatureKey = (signature: string): string =>
  createHash('sha256').update(signature).digest('hex').slice(0, 8);

const squash = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A lesson recording that `fix` made the failure with `signature` pass. */
export function fixNote(signature: string, fix: string, today: string): Note {
  return {
    id: 'N0',
    type: 'pitfall',
    text: `[sig:${signatureKey(signature)}] When "${squash(signature, SIG_CHARS)}" failed, this fixed it: ${squash(fix, FIX_CHARS)}`,
    date: today,
  };
}

/** The recorded fix for `signature`, if a lesson has one. */
export function recallFix(notes: readonly Note[], signature: string): string | undefined {
  const key = signatureKey(signature);
  const hit = [...notes].reverse().find((n) => TAG.exec(n.text)?.[1] === key);
  return hit?.text.replace(TAG, '').trim();
}
