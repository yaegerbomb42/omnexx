import type { Command } from './commands.ts';

/** One undoable step: the commands to replay forward, and their inverses in undo order. */
export interface Step {
  forward: readonly Command[];
  backward: readonly Command[];
}

/** Bounded undo/redo stacks. */
export class History {
  private done: Step[] = [];
  private undone: Step[] = [];

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  record(step: Step): void {
    this.done = [...this.done, step].slice(-this.limit);
    this.undone = [];
  }

  takeUndo(): Step | undefined {
    const step = this.done.at(-1);
    if (step) {
      this.done = this.done.slice(0, -1);
      this.undone = [...this.undone, step];
    }
    return step;
  }

  takeRedo(): Step | undefined {
    const step = this.undone.at(-1);
    if (step) {
      this.undone = this.undone.slice(0, -1);
      this.done = [...this.done, step];
    }
    return step;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }
}
