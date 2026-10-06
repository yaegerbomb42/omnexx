import type { JEPASalienceArbiter } from './arbiter.js';
import { createBlock, type BankType, type ContextBlock } from './blocks.js';

export interface BankStats {
  bankType: BankType;
  blocks: number;
  tokens: number;
  tokenBudget: number;
  pinned: number;
}

/**
 * One isolated context bank. Blocks are discretely indexed by id and ordered by
 * insertion; eviction picks the lowest-salience unpinned block, so removal is
 * non-linear (any position can go) rather than oldest-first.
 */
export class MemoryBank {
  readonly bankType: BankType;
  readonly tokenBudget: number;
  private readonly blocks = new Map<string, ContextBlock>();
  private tokens = 0;

  constructor(
    bankType: BankType,
    tokenBudget: number,
    private readonly arbiter: JEPASalienceArbiter,
  ) {
    this.bankType = bankType;
    this.tokenBudget = tokenBudget;
  }

  /**
   * Insert content as a new semantic block. The arbiter embeds and scores it,
   * observes its latent (updating the bank's target representation), and evicts
   * low-salience blocks until the bank fits its token budget. Returns the block,
   * or undefined when the content itself exceeds the budget.
   */
  insert(content: string, opts: { isPinned?: boolean } = {}): ContextBlock | undefined {
    const block = createBlock(this.bankType, content, opts);
    if (block.tokenCount > this.tokenBudget) return undefined;
    block.embedding = this.arbiter.encode(content);
    block.salience = this.arbiter.score(this.bankType, block.embedding, block.timestamp);
    this.arbiter.observe(this.bankType, block.embedding);
    this.blocks.set(block.id, block);
    this.tokens += block.tokenCount;
    this.evictToBudget();
    return block;
  }

  remove(id: string): boolean {
    const block = this.blocks.get(id);
    if (!block) return false;
    this.blocks.delete(id);
    this.tokens -= block.tokenCount;
    return true;
  }

  get(id: string): ContextBlock | undefined {
    return this.blocks.get(id);
  }

  pin(id: string): boolean {
    const block = this.blocks.get(id);
    if (!block) return false;
    block.isPinned = true;
    return true;
  }

  /** Re-score every block against the arbiter's current target representation. */
  rescore(nowS?: number): void {
    const now = nowS ?? Date.now() / 1000;
    for (const block of this.blocks.values()) {
      if (block.embedding)
        block.salience = this.arbiter.score(this.bankType, block.embedding, block.timestamp, now);
    }
  }

  /** Evict lowest-salience unpinned blocks until the bank fits its budget. */
  evictToBudget(): ContextBlock[] {
    const evicted: ContextBlock[] = [];
    while (this.tokens > this.tokenBudget) {
      const victim = this.lowestSalienceBlock();
      if (!victim) break; // everything left is pinned
      this.remove(victim.id);
      evicted.push(victim);
    }
    return evicted;
  }

  lowestSalienceBlock(): ContextBlock | undefined {
    let victim: ContextBlock | undefined;
    for (const block of this.blocks.values()) {
      if (block.isPinned) continue;
      if (
        !victim ||
        block.salience < victim.salience ||
        (block.salience === victim.salience && block.timestamp < victim.timestamp)
      )
        victim = block;
    }
    return victim;
  }

  /** All blocks, most salient first. */
  ranked(): ContextBlock[] {
    return [...this.blocks.values()].sort((a, b) => b.salience - a.salience);
  }

  get size(): number {
    return this.blocks.size;
  }

  get tokenCount(): number {
    return this.tokens;
  }

  stats(): BankStats {
    let pinned = 0;
    for (const block of this.blocks.values()) if (block.isPinned) pinned++;
    return {
      bankType: this.bankType,
      blocks: this.blocks.size,
      tokens: this.tokens,
      tokenBudget: this.tokenBudget,
      pinned,
    };
  }
}

/** $C_{conv}$ — ephemeral multi-turn dialogue buffer. */
export class BankConversation extends MemoryBank {
  constructor(arbiter: JEPASalienceArbiter, tokenBudget = 4_000) {
    super('conversation', tokenBudget, arbiter);
  }
}

/** $C_{work}$ — active execution frame: tool calls, stdout/stderr, step feedback. */
export class BankWorking extends MemoryBank {
  constructor(arbiter: JEPASalienceArbiter, tokenBudget = 6_000) {
    super('working', tokenBudget, arbiter);
  }
}

/** $C_{epist}$ — preferences, project conventions, compressed agent takeaways. */
export class BankEpisodic extends MemoryBank {
  constructor(arbiter: JEPASalienceArbiter, tokenBudget = 3_000) {
    super('episodic', tokenBudget, arbiter);
  }
}

/** $C_{agenda}$ — high-level goals, dependency graph, pending todo constraints. */
export class BankAgenda extends MemoryBank {
  constructor(arbiter: JEPASalienceArbiter, tokenBudget = 2_000) {
    super('agenda', tokenBudget, arbiter);
  }
}
