import { readFile } from 'node:fs/promises';

/**
 * Read a UTF-8 file, or undefined when it does not exist or cannot be read. Unreadable
 * instruction and skill files are skipped instead of failing a run.
 */
export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
