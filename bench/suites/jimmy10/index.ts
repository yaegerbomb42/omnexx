import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirSuite } from '../dir-suite.ts';
import type { Suite } from '../../types.ts';

/** Other script suites (web5) build theirs from this with their own name and task folder. */
export { DirSuite as Jimmy10Suite } from '../dir-suite.ts';

/** jimmy10: ten small tasks (see the task directories). */
export function getJimmy10Suite(): Suite {
  return new DirSuite('jimmy10', dirname(fileURLToPath(import.meta.url)));
}
