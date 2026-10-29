import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirSuite } from '../dir-suite.ts';
import type { Suite } from '../../types.ts';

/** time: reuses jimmy10 tasks so time-budget behaviour can be measured on known work. */
export function getTimeSuite(): Suite {
  // Point at the jimmy10 task directories; the suite name is what shows in results.
  return new DirSuite('time', dirname(fileURLToPath(new URL('../../jimmy10', import.meta.url))));
}
