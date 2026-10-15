import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Suite } from '../../types.ts';
import { Jimmy10Suite } from '../jimmy10/index.ts';

const SUITE_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * web5 suite: tasks that need the web. Each serves its docs (or the page under test) from
 * 127.0.0.1 via `.docs/serve.sh`, so runs are offline and deterministic. Same layout as
 * jimmy10: setup.sh, goal.md, hidden check.sh, and a reference solution/ per task.
 */
export function getWeb5Suite(): Suite {
  return new Jimmy10Suite('web5', SUITE_ROOT);
}
