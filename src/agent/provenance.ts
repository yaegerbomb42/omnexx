import { z } from 'zod';

export const patchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('APPEND_FACT'),
    fact: z.string().min(1).max(1_000),
    category: z.enum(['build', 'test', 'env', 'architecture']).default('architecture'),
  }),
  z.strictObject({
    op: z.literal('MARK_PATH_INVALID'),
    path: z.string().min(1),
    reason: z.string().min(1).max(1_000),
  }),
  z.strictObject({
    op: z.literal('RECORD_DECISION'),
    key: z.string().min(1).max(200),
    value: z.string().min(1).max(1_000),
    rationale: z.string().max(1_000).default(''),
  }),
  z.strictObject({
    op: z.literal('REVOKE_FACT'),
    factId: z.string().min(1),
    reason: z.string().max(1_000).default(''),
  }),
]);

export type PatchOp = z.infer<typeof patchOpSchema>;

export const statePatchSchema = z.strictObject({
  id: z.string().describe('Unique patch identifier (e.g. patch-c1-t3-0)'),
  sourceTurnId: z.number().int().nonnegative().describe('Originating turn number for epistemic provenance'),
  cycle: z.number().int().nonnegative().describe('Cycle in which this patch was produced'),
  timestamp: z.number().int().nonnegative().describe('Epoch millisecond timestamp'),
  author: z.string().default('agent'),
  ops: z.array(patchOpSchema).min(1),
});

export type StatePatch = z.infer<typeof statePatchSchema>;

export interface EpistemicFact {
  id: string;
  fact: string;
  category: 'build' | 'test' | 'env' | 'architecture';
  sourceTurnId: number;
  cycle: number;
  active: boolean;
}

export interface EpistemicState {
  facts: EpistemicFact[];
  invalidPaths: Map<string, { reason: string; cycle: number; turn: number }>;
  decisions: Map<string, { value: string; rationale: string; cycle: number; turn: number }>;
}

export class EpistemicStateReducer {
  private state: EpistemicState = {
    facts: [],
    invalidPaths: new Map(),
    decisions: new Map(),
  };

  private readonly patchLog: StatePatch[] = [];

  constructor(initialPatches: readonly StatePatch[] = []) {
    for (const patch of initialPatches) {
      this.apply(patch);
    }
  }

  public apply(patch: StatePatch): void {
    statePatchSchema.parse(patch);
    this.patchLog.push(patch);

    for (let i = 0; i < patch.ops.length; i++) {
      const op = patch.ops[i];
      if (!op) continue;
      switch (op.op) {
        case 'APPEND_FACT': {
          this.state.facts.push({
            id: `${patch.id}-${i}`,
            fact: op.fact,
            category: op.category,
            sourceTurnId: patch.sourceTurnId,
            cycle: patch.cycle,
            active: true,
          });
          break;
        }
        case 'REVOKE_FACT': {
          const match = this.state.facts.find((f) => f.id === op.factId);
          if (match) match.active = false;
          break;
        }
        case 'MARK_PATH_INVALID': {
          this.state.invalidPaths.set(op.path, {
            reason: op.reason,
            cycle: patch.cycle,
            turn: patch.sourceTurnId,
          });
          break;
        }
        case 'RECORD_DECISION': {
          this.state.decisions.set(op.key, {
            value: op.value,
            rationale: op.rationale,
            cycle: patch.cycle,
            turn: patch.sourceTurnId,
          });
          break;
        }
      }
    }
  }

  public getActiveFacts(): readonly EpistemicFact[] {
    return this.state.facts.filter((f) => f.active);
  }

  public getInvalidPaths(): ReadonlyMap<string, { reason: string; cycle: number; turn: number }> {
    return this.state.invalidPaths;
  }

  public getDecisions(): ReadonlyMap<string, { value: string; rationale: string; cycle: number; turn: number }> {
    return this.state.decisions;
  }

  public getHistory(): readonly StatePatch[] {
    return Object.freeze([...this.patchLog]);
  }
}
