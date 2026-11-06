import { createHash } from 'node:crypto';
import { TokenCounter } from '../core/token-count.js';
import type { ContentBlock, Message } from '../providers/types.js';
import { SupersedeIndex } from './supersede-index.js';
import { foldPaysOff } from '../runtime/kernel/cache-epoch.js';

export type Rep = 0 | 1 | 2; // 0 = STUB, 1 = DIGEST, 2 = FULL

export const REP_STUB: Rep = 0;
export const REP_DIGEST: Rep = 1;
export const REP_FULL: Rep = 2;

export interface AtomicUnit {
  id: string; // tool_use id
  name: string;
  useMessageIdx: number;
  useBlockIdx: number;
  resultMessageIdx: number;
  resultBlockIdx: number;
  path: string | undefined;
  command: string | undefined;
  isError: boolean;
  exitCode?: number | undefined;
  currentRep: Rep;
  floorRep: Rep;
  fullTokens: number;
  digestTokens: number;
  stubTokens: number;
  utility: [number, number, number]; // [U(stub), U(digest), U(full)]
  originalContent: string;
  failingTests: string[];
  assertions: string[];
}

export interface WorkingSet {
  activeFiles: Map<string, number>; // path -> score
  activeSymbols: Map<string, number>;
  unresolvedErrors: Set<string>;
  openTodos: Set<string>;
}

export interface PlannerConfig {
  budget: {
    soft: number;
    hard: number;
  };
  cache: {
    horizonMax: number;
    persistence: number;
  };
  protectedTailTurns: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  budget: {
    soft: 150_000,
    hard: 190_000,
  },
  cache: {
    horizonMax: 25,
    persistence: 0.8,
  },
  protectedTailTurns: 3,
};

export interface PlanAction {
  unitId: string;
  fromRep: Rep;
  toRep: Rep;
  reason: string;
}

export interface PlanResult {
  actions: PlanAction[];
  expectedTokensBefore: number;
  expectedTokensAfter: number;
  freedTokens: number;
  cacheBreakPoint: number | null;
  npv: number;
  reasons: string[];
}

export function digestBash(command: string, content: string, isError: boolean): string {
  const lines = content.split('\n');
  const failingTests: string[] = [];
  const assertions: string[] = [];
  const stackFrames: string[] = [];
  let fatalLine = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (/fail(ed|ure)?\b|✕|✖/i.test(trimmed)) {
      if (failingTests.length < 5 && trimmed.length > 5) {
        failingTests.push(trimmed.slice(0, 160));
      }
    }
    if (/expected\b|received\b|assertionerror|assert/i.test(trimmed)) {
      if (assertions.length < 4 && trimmed.length > 5) {
        assertions.push(trimmed.slice(0, 160));
      }
    }
    if (/^\s*at\s+.*\(?.*:\d+:\d+\)?/.test(trimmed)) {
      if (stackFrames.length < 4 && !trimmed.includes('node_modules')) {
        stackFrames.push(trimmed.slice(0, 160));
      }
    }
    if (!fatalLine && /error:|fatal:|exception:/i.test(trimmed)) {
      fatalLine = trimmed.slice(0, 200);
    }
  }

  const summaryParts: string[] = [
    `[digest bash: \`${command.slice(0, 80)}\`${isError ? ' (failed)' : ' (ok)'}]`,
  ];
  if (failingTests.length > 0) {
    summaryParts.push('failing_tests:\n' + failingTests.map((t) => `  - ${t}`).join('\n'));
  }
  if (assertions.length > 0) {
    summaryParts.push('assertions:\n' + assertions.map((a) => `  - ${a}`).join('\n'));
  }
  if (stackFrames.length > 0) {
    summaryParts.push('project_stack:\n' + stackFrames.map((s) => `  - ${s}`).join('\n'));
  }
  if (fatalLine) {
    summaryParts.push(`fatal: ${fatalLine}`);
  }
  const tailLines = lines.slice(-4).map((l) => l.slice(0, 160));
  summaryParts.push('tail:\n' + tailLines.join('\n'));

  return summaryParts.join('\n');
}

export function digestRead(path: string, content: string): string {
  const lines = content.split('\n');
  const outline: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^(export\s+)?(function|class|interface|type|const|let|enum)\b/.test(trimmed) ||
      /^def\s+|^class\s+/.test(trimmed)
    ) {
      if (outline.length < 15) {
        outline.push(trimmed.slice(0, 140));
      }
    }
  }
  const header = `[digest read: ${path} (${lines.length} lines, ${content.length} chars)]`;
  if (outline.length > 0) {
    return `${header}\ndeclarations:\n` + outline.map((o) => `  - ${o}`).join('\n');
  }
  const head = lines
    .slice(0, 6)
    .map((l) => l.slice(0, 140))
    .join('\n');
  return `${header}\n${head}\n…`;
}

export function digestEdit(path: string, content: string): string {
  const lines = content.split('\n');
  const hunks: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')) {
      hunks.push(line.slice(0, 120));
    }
  }
  const header = `[digest edit: ${path}]`;
  if (hunks.length > 0) {
    return `${header}\nhunks:\n` + hunks.slice(0, 10).join('\n');
  }
  return `${header} ${content.slice(0, 200)}…`;
}

export function digestGeneric(name: string, content: string): string {
  const lines = content.split('\n');
  const head = lines
    .slice(0, 4)
    .map((l) => l.slice(0, 140))
    .join('\n');
  const tail =
    lines.length > 8
      ? '\n…\n' +
        lines
          .slice(-3)
          .map((l) => l.slice(0, 140))
          .join('\n')
      : '';
  return `[digest ${name}: ${content.length} chars]\n${head}${tail}`;
}

export function createStubText(unit: AtomicUnit, reason: string): string {
  const pathStr = unit.path ? ` path="${unit.path}"` : '';
  const cmdStr = unit.command ? ` cmd="${unit.command.slice(0, 60)}"` : '';
  const exitStr = unit.exitCode !== undefined ? ` exit=${unit.exitCode}` : '';
  const hash = createHash('sha256').update(unit.originalContent).digest('hex').slice(0, 8);
  return `[stub ${unit.name} id="${unit.id}"${pathStr}${cmdStr}${exitStr} orig=${unit.originalContent.length}c hash=${hash}; ${reason}]`;
}

export const DeterministicDigester = {
  digestBash,
  digestRead,
  digestEdit,
  digestGeneric,
  createStub: createStubText,
};

/**
 * ContextPlanner is the unified mutation authority for conversation context.
 */
export class ContextPlanner {
  private readonly tokenCounter: TokenCounter;

  constructor(tokenCounter?: TokenCounter) {
    this.tokenCounter = tokenCounter ?? new TokenCounter();
  }

  public getTokenCounter(): TokenCounter {
    return this.tokenCounter;
  }

  /**
   * Plan context management operations deterministically.
   */
  public plan(
    messages: readonly Message[],
    budget: number = DEFAULT_PLANNER_CONFIG.budget.hard,
    cachedPrefixBoundary?: number,
  ): PlanResult {
    const units = this.extractAtomicUnits(messages);
    const workingSet = this.buildWorkingSet(messages);
    this.computeUnitFeatures(units, workingSet);

    const totalBefore = this.tokenCounter.sync(messages);
    const actions: PlanAction[] = [];
    const reasons: string[] = [];

    const protectedTurnThreshold = this.getProtectedTurnBoundary(
      messages,
      DEFAULT_PLANNER_CONFIG.protectedTailTurns,
    );

    let projectedTokens = totalBefore;

    for (const unit of units) {
      if (unit.resultMessageIdx >= protectedTurnThreshold) {
        unit.floorRep = Math.max(unit.floorRep, REP_DIGEST) as Rep;
        continue;
      }

      const isUncachedSuffix =
        cachedPrefixBoundary === undefined || unit.resultMessageIdx >= cachedPrefixBoundary;

      if (isUncachedSuffix && unit.currentRep > unit.floorRep) {
        if (unit.floorRep === REP_STUB && unit.currentRep > REP_STUB) {
          actions.push({
            unitId: unit.id,
            fromRep: unit.currentRep,
            toRep: REP_STUB,
            reason: 'uncached suffix compaction to stub',
          });
          projectedTokens -=
            unit.currentRep === REP_FULL
              ? unit.fullTokens - unit.stubTokens
              : unit.digestTokens - unit.stubTokens;
          unit.currentRep = REP_STUB;
        } else if (unit.floorRep === REP_DIGEST && unit.currentRep === REP_FULL) {
          actions.push({
            unitId: unit.id,
            fromRep: REP_FULL,
            toRep: REP_DIGEST,
            reason: 'uncached suffix compaction to digest',
          });
          projectedTokens -= unit.fullTokens - unit.digestTokens;
          unit.currentRep = REP_DIGEST;
        }
      }
    }

    if (projectedTokens > budget) {
      interface DowngradeCandidate {
        unit: AtomicUnit;
        toRep: Rep;
        tokenGain: number;
        utilityLoss: number;
        ratio: number;
      }

      const candidates: DowngradeCandidate[] = [];
      for (const unit of units) {
        if (unit.resultMessageIdx >= protectedTurnThreshold) continue;

        if (unit.currentRep === REP_FULL && unit.floorRep <= REP_DIGEST) {
          const gain = unit.fullTokens - unit.digestTokens;
          const loss = Math.max(0.001, unit.utility[REP_FULL] - unit.utility[REP_DIGEST]);
          if (gain > 0) {
            candidates.push({
              unit,
              toRep: REP_DIGEST,
              tokenGain: gain,
              utilityLoss: loss,
              ratio: loss / gain,
            });
          }
        } else if (unit.currentRep === REP_DIGEST && unit.floorRep === REP_STUB) {
          const gain = unit.digestTokens - unit.stubTokens;
          const loss = Math.max(0.001, unit.utility[REP_DIGEST] - unit.utility[REP_STUB]);
          if (gain > 0) {
            candidates.push({
              unit,
              toRep: REP_STUB,
              tokenGain: gain,
              utilityLoss: loss,
              ratio: loss / gain,
            });
          }
        }
      }

      candidates.sort((a, b) => a.ratio - b.ratio || a.unit.id.localeCompare(b.unit.id));

      for (const cand of candidates) {
        if (projectedTokens <= budget) break;

        if (
          cachedPrefixBoundary !== undefined &&
          cand.unit.resultMessageIdx < cachedPrefixBoundary
        ) {
          const suffixTokensToBust = totalBefore;
          const paysOff = foldPaysOff({
            freedTokens: cand.tokenGain,
            expectedRemainingTurns: 10,
            suffixTokensToBust,
          });
          if (!paysOff && projectedTokens <= budget * 1.1) {
            continue;
          }
        }

        const existingAction = actions.find((a) => a.unitId === cand.unit.id);
        if (existingAction) {
          existingAction.toRep = cand.toRep;
        } else {
          actions.push({
            unitId: cand.unit.id,
            fromRep: cand.unit.currentRep,
            toRep: cand.toRep,
            reason: `budget enforcement to ${cand.toRep === REP_STUB ? 'stub' : 'digest'}`,
          });
        }
        projectedTokens -= cand.tokenGain;
        cand.unit.currentRep = cand.toRep;
      }
    }

    const freedTokens = Math.max(0, totalBefore - projectedTokens);

    return {
      actions,
      expectedTokensBefore: totalBefore,
      expectedTokensAfter: projectedTokens,
      freedTokens,
      cacheBreakPoint: cachedPrefixBoundary ?? null,
      npv: 0,
      reasons,
    };
  }

  /**
   * Apply plan atomically to message history, producing a new array of Messages.
   * Enforces tool-pair integrity and message 0 immutability.
   */
  public applyPlan(messages: readonly Message[], plan: PlanResult): Message[] {
    if (!plan.actions.length) {
      return [...messages];
    }

    const actionMap = new Map<string, PlanAction>();
    for (const a of plan.actions) {
      actionMap.set(a.unitId, a);
    }

    const units = this.extractAtomicUnits(messages);
    const unitMap = new Map<string, AtomicUnit>();
    for (const u of units) {
      unitMap.set(u.id, u);
    }

    const out: Message[] = messages.map((m, i) => {
      if (i === 0) {
        return { ...m, content: [...m.content] };
      }

      const hasAction = m.content.some(
        (b) => b.type === 'tool_result' && actionMap.has(b.toolUseId),
      );
      if (!hasAction) {
        return { ...m, content: [...m.content] };
      }

      const newContent: ContentBlock[] = m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        const act = actionMap.get(b.toolUseId);
        const unit = unitMap.get(b.toolUseId);
        if (!act || !unit) return b;

        if (act.toRep === REP_STUB) {
          const stubText = createStubText(unit, act.reason);
          return { ...b, content: stubText };
        } else if (act.toRep === REP_DIGEST) {
          let digestText: string;
          if (unit.name === 'bash') {
            digestText = digestBash(unit.command ?? '', unit.originalContent, unit.isError);
          } else if (unit.name === 'read' && unit.path) {
            digestText = digestRead(unit.path, unit.originalContent);
          } else if (
            (unit.name === 'edit' || unit.name === 'write_file' || unit.name === 'replace_lines') &&
            unit.path
          ) {
            digestText = digestEdit(unit.path, unit.originalContent);
          } else {
            digestText = digestGeneric(unit.name, unit.originalContent);
          }
          return { ...b, content: digestText };
        }
        return b;
      });

      return { ...m, content: newContent };
    });

    this.assertPairIntegrity(out);

    return out;
  }

  private extractAtomicUnits(messages: readonly Message[]): AtomicUnit[] {
    const toolUses = new Map<string, { msgIdx: number; blockIdx: number; block: ContentBlock }>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      for (let j = 0; j < msg.content.length; j++) {
        const b = msg.content[j];
        if (b?.type === 'tool_use') {
          toolUses.set(b.id, { msgIdx: i, blockIdx: j, block: b });
        }
      }
    }

    const units: AtomicUnit[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      for (let j = 0; j < msg.content.length; j++) {
        const b = msg.content[j];
        if (b?.type === 'tool_result') {
          const useInfo = toolUses.get(b.toolUseId);
          if (!useInfo) continue;
          const useBlock = useInfo.block;
          if (useBlock.type !== 'tool_use') continue;

          const input =
            typeof useBlock.input === 'object' && useBlock.input !== null
              ? (useBlock.input as Record<string, unknown>)
              : {};
          const p = typeof input.path === 'string' ? input.path : undefined;
          const cmd = typeof input.command === 'string' ? input.command : undefined;

          let currentRep: Rep = REP_FULL;
          if (
            b.content.startsWith('[stub ') ||
            b.content.startsWith('[superseded ') ||
            b.content.startsWith('[cleared ')
          ) {
            currentRep = REP_STUB;
          } else if (b.content.startsWith('[digest ')) {
            currentRep = REP_DIGEST;
          }

          const fullTokens = this.tokenCounter.estimateString(b.content) + 6;
          const digestTokens = Math.min(fullTokens, Math.max(40, Math.floor(fullTokens * 0.35)));
          const stubTokens = 25;

          units.push({
            id: b.toolUseId,
            name: useBlock.name,
            useMessageIdx: useInfo.msgIdx,
            useBlockIdx: useInfo.blockIdx,
            resultMessageIdx: i,
            resultBlockIdx: j,
            path: p,
            command: cmd,
            isError: b.isError === true,
            currentRep,
            floorRep: REP_STUB,
            fullTokens,
            digestTokens,
            stubTokens,
            utility: [0.1, 0.7, 1.0],
            originalContent: b.content,
            failingTests: [],
            assertions: [],
          });
        }
      }
    }

    return units;
  }

  private buildWorkingSet(messages: readonly Message[]): WorkingSet {
    const activeFiles = new Map<string, number>();
    const activeSymbols = new Map<string, number>();
    const unresolvedErrors = new Set<string>();
    const openTodos = new Set<string>();

    const totalTurns = messages.length;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      const ageTurns = totalTurns - i;
      const decay = Math.exp(-ageTurns / 15);

      for (const b of msg.content) {
        if (b.type === 'tool_use') {
          const input =
            typeof b.input === 'object' && b.input !== null
              ? (b.input as Record<string, unknown>)
              : {};
          if (typeof input.path === 'string') {
            const p = input.path;
            const currentScore = activeFiles.get(p) ?? 0;
            const weight =
              b.name === 'edit' || b.name === 'write_file' || b.name === 'replace_lines'
                ? 2.0
                : 0.8;
            activeFiles.set(p, Math.min(3.0, currentScore + weight * decay));
          }
          if (b.name === 'todo' && Array.isArray(input.items)) {
            for (const it of input.items) {
              if (it && typeof it === 'object') {
                const todoObj = it as { text?: unknown; status?: unknown };
                if (todoObj.status !== 'done' && typeof todoObj.text === 'string') {
                  openTodos.add(todoObj.text);
                }
              }
            }
          }
        } else if (b.type === 'tool_result' && b.isError) {
          const errFingerprint = b.content.slice(0, 100).replace(/\s+/g, ' ');
          unresolvedErrors.add(errFingerprint);
        }
      }
    }

    return {
      activeFiles,
      activeSymbols,
      unresolvedErrors,
      openTodos,
    };
  }

  private computeUnitFeatures(units: AtomicUnit[], ws: WorkingSet): void {
    const superseded = SupersedeIndex.scan(
      units.map((u) => ({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: u.id,
            content: u.originalContent,
            isError: u.isError,
          },
        ],
      })),
    );

    const supersededMap = new Map<string, boolean>();
    for (const s of superseded) {
      supersededMap.set(s.toolUseId, true);
    }

    for (const u of units) {
      let fileScore = 0;
      if (u.path) {
        fileScore = ws.activeFiles.get(u.path) ?? 0;
      }

      if (u.isError) {
        u.floorRep = REP_DIGEST;
      } else if (fileScore > 1.5 && (u.name === 'edit' || u.name === 'write_file')) {
        u.floorRep = REP_DIGEST;
      } else if (supersededMap.has(u.id)) {
        u.floorRep = REP_STUB;
      }

      const baseUtil = 0.1;
      const fileUtil = fileScore * 0.4;
      const errUtil = u.isError ? 2.0 : 0.0;
      const fullUtil = baseUtil + fileUtil + errUtil;
      const digestUtil = fullUtil * 0.75;
      const stubUtil = fullUtil * 0.15;

      u.utility = [stubUtil, digestUtil, fullUtil];
    }
  }

  private getProtectedTurnBoundary(messages: readonly Message[], tailTurns: number): number {
    const assistantIndices = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
    if (assistantIndices.length <= tailTurns) {
      return 0;
    }
    const targetIdx = assistantIndices[assistantIndices.length - tailTurns];
    return targetIdx ?? 0;
  }

  private assertPairIntegrity(messages: readonly Message[]): void {
    const uses = new Set<string>();
    const results = new Set<string>();

    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          uses.add(b.id);
        } else if (b.type === 'tool_result') {
          results.add(b.toolUseId);
        }
      }
    }

    for (const resId of results) {
      if (!uses.has(resId)) {
        throw new Error(`ContextPlanner invariant violation: orphaned tool_result id ${resId}`);
      }
    }
  }
}
