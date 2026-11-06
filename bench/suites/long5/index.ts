import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirSuite } from '../dir-suite.ts';
import type { Suite } from '../../types.ts';

/**
 * long5: 5 long tasks rebuilt from this repo's big merged PRs (#143, #144, #146, #147, #170).
 * Each task starts at the PR's parent commit and uses that PR's own tests as the hidden oracle,
 * restored so the agent can't edit them.
 *
 * Task layout per PR:
 *   setup.sh   - git checkout parent commit, copy PR's test files into hidden/
 *   goal.md    - the PR's feature description as the agent's goal
 *   check.sh   - run the PR's tests (hidden oracle) plus repo's own tests
 *   hidden/    - PR's test files, restored before check so agent can't edit them
 */
export function getLong5Suite(): Suite {
  return new DirSuite('long5', dirname(fileURLToPath(import.meta.url)));
}
