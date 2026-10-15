import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirSuite } from '../dir-suite.ts';
import type { Suite } from '../../types.ts';

/**
 * hard10: multi-file features, cross-module bug hunts, issue-style fixes, behavior-preserving
 * refactors, a jsdom-checked frontend task and a TS+Python task. See README.md.
 */
export function getHard10Suite(): Suite {
  return new DirSuite('hard10', dirname(fileURLToPath(import.meta.url)));
}
