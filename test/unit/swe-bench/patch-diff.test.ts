import { describe, expect, it } from 'vitest';
import {
  formatForSubmission,
  isDiffEmpty,
  summarizePatch,
  type PatchDiff,
} from '../../../src/swe-bench/patch-diff.js';

describe('patch-diff', () => {
  describe('formatForSubmission', () => {
    it('strips git headers', () => {
      const diff = `diff --git a/src/main.ts b/src/main.ts
index abc123..def456 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 function main() {
+  console.log('hello');
 }
`;
      const formatted = formatForSubmission(diff);
      expect(formatted).not.toContain('diff --git');
      expect(formatted).not.toContain('index abc123');
      expect(formatted).toContain('--- src/main.ts');
      expect(formatted).toContain('+++ src/main.ts');
      expect(formatted).toContain("+  console.log('hello');");
    });

    it('handles empty diff', () => {
      const formatted = formatForSubmission('');
      expect(formatted).toBe('');
    });
  });

  describe('isDiffEmpty', () => {
    it('returns true for empty patch', () => {
      const patch: PatchDiff = { files: [], diff: '', stats: { additions: 0, deletions: 0 } };
      expect(isDiffEmpty(patch)).toBe(true);
    });

    it('returns false for non-empty patch', () => {
      const patch: PatchDiff = {
        files: ['src/main.ts'],
        diff: 'diff...',
        stats: { additions: 1, deletions: 0 },
      };
      expect(isDiffEmpty(patch)).toBe(false);
    });
  });

  describe('summarizePatch', () => {
    it('summarizes empty patch', () => {
      const patch: PatchDiff = { files: [], diff: '', stats: { additions: 0, deletions: 0 } };
      expect(summarizePatch(patch)).toBe('No changes');
    });

    it('summarizes single file patch', () => {
      const patch: PatchDiff = {
        files: ['src/main.ts'],
        diff: 'diff...',
        stats: { additions: 5, deletions: 2 },
      };
      const summary = summarizePatch(patch);
      expect(summary).toContain('1 files changed');
      expect(summary).toContain('src/main.ts');
      expect(summary).toContain('+5');
      expect(summary).toContain('-2');
    });

    it('summarizes multi-file patch', () => {
      const patch: PatchDiff = {
        files: ['a.ts', 'b.ts', 'c.ts'],
        diff: 'diff...',
        stats: { additions: 10, deletions: 5 },
      };
      const summary = summarizePatch(patch);
      expect(summary).toContain('3 files changed');
    });

    it('truncates long file lists', () => {
      const patch: PatchDiff = {
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
        diff: 'diff...',
        stats: { additions: 20, deletions: 10 },
      };
      const summary = summarizePatch(patch);
      expect(summary).toContain('+2 more');
    });
  });
});
