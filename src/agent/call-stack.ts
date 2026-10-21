import { z } from 'zod';

export const TRAP_KINDS = [
  'ASSUMPTION_INVALID',
  'DEPENDENCY_MISSING',
  'ENVIRONMENT_INCOMPATIBLE',
  'BUDGET_PRESSURE',
  'TASK_TOO_LARGE',
] as const;

export type TrapKind = (typeof TRAP_KINDS)[number];

export const stackFrameSchema = z.strictObject({
  id: z.string().describe('Unique frame identifier (e.g. frame-M1.T01-0)'),
  taskId: z.string().describe('Originating task identifier'),
  title: z.string().describe('Frame goal or focus'),
  assumptions: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  pushedAtCycle: z.number().int().nonnegative(),
  pushedAtTurn: z.number().int().nonnegative().optional(),
  gitCommitSha: z.string().optional(),
  status: z.enum(['active', 'resolved', 'trapped']).default('active'),
  trap: z
    .strictObject({
      kind: z.enum(TRAP_KINDS),
      detail: z.string(),
      turn: z.number().int().nonnegative(),
    })
    .optional(),
});

export type StackFrame = z.infer<typeof stackFrameSchema>;

export class ExecutionCallStack {
  private readonly frames: StackFrame[] = [];

  constructor(initialFrames: readonly StackFrame[] = []) {
    this.frames = [...initialFrames];
  }

  public push(frame: StackFrame): void {
    this.frames.push(frame);
  }

  public current(): StackFrame | undefined {
    return this.frames.at(-1);
  }

  public pop(): StackFrame | undefined {
    return this.frames.pop();
  }

  public raiseTrap(kind: TrapKind, detail: string, turn: number): StackFrame | undefined {
    const cur = this.current();
    if (!cur) return undefined;
    cur.status = 'trapped';
    cur.trap = { kind, detail, turn };
    return cur;
  }

  /**
   * Deterministically unwind frames down to a target frame or until an untrapped parent is reached.
   * Returns all discarded/unwound frames.
   */
  public unwindTo(frameId: string): readonly StackFrame[] {
    const targetIdx = this.frames.findIndex((f) => f.id === frameId);
    if (targetIdx === -1) return [];
    return Object.freeze(this.frames.splice(targetIdx + 1));
  }

  public toJSON(): readonly StackFrame[] {
    return Object.freeze([...this.frames]);
  }
}
