import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readTextOr, writeFileAtomic } from './atomic.js';
import type { RunStore } from './run-store.js';

export const CONTEXT_KINDS = ['progress', 'solution', 'dead_end', 'checkpoint', 'summary'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** What the next cycle sees: the newest part, since the end is where the work is. */
const SHOWN_CHARS = 12_000;

const fileFor = (store: RunStore, key: string): string =>
  store.file(`running-context/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);
const doneFor = (store: RunStore, key: string): string =>
  store.file(`running-context/done/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.md`);

/**
 * A living memory per task (or chat): progress, what worked, dead ends, checkpoints, summaries,
 * written by the agent and the harness as the work goes, and fed back at the start of every
 * cycle so a fresh context starts from where the work actually is. Lives in the run's folder,
 * never in the repo.
 */
export class RunningContext {
  constructor(
    private readonly store: RunStore,
    readonly key: string,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<string> {
    return readTextOr(fileFor(this.store, this.key), '');
  }

  async add(kind: ContextKind, text: string, label = ''): Promise<void> {
    const file = fileFor(this.store, this.key);
    const before = await readTextOr(file, `# Running context: ${this.key}\n`);
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ');
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(
      file,
      `${before}\n### ${kind}${label ? ` · ${label}` : ''} · ${stamp}\n${text.trim()}\n`,
    );
  }

  /** The part to show the model: the whole file if small, else its title and newest entries. */
  async forPrompt(): Promise<string> {
    const all = (await this.read()).trim();
    if (all.length <= SHOWN_CHARS) return all;
    const cut = all.indexOf('\n### ', all.length - SHOWN_CHARS);
    const tail = cut >= 0 ? all.slice(cut + 1) : all.slice(-SHOWN_CHARS);
    return `# Running context: ${this.key} (older entries omitted)\n\n${tail}`;
  }

  /** The work is done: move the file aside (shared in walkthroughs) and return what it said. */
  async archive(): Promise<string> {
    const from = fileFor(this.store, this.key);
    const text = await readTextOr(from, '');
    if (!text) return '';
    const to = doneFor(this.store, this.key);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return text;
  }

  /** Archived contexts for these keys, for the walkthrough. */
  static async archived(
    store: RunStore,
    keys: readonly string[],
  ): Promise<{ key: string; text: string }[]> {
    const have = new Set(await readdir(dirname(doneFor(store, 'x'))).catch(() => [] as string[]));
    const out: { key: string; text: string }[] = [];
    for (const key of keys) {
      const f = doneFor(store, key);
      if (!have.has(f.split('/').pop() ?? '')) continue;
      out.push({ key, text: await readTextOr(f, '') });
    }
    return out;
  }
}
