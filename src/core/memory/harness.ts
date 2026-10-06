import { JEPASalienceArbiter, type ArbiterOptions } from './arbiter.js';
import {
  BankAgenda,
  BankConversation,
  BankEpisodic,
  BankWorking,
  type BankStats,
} from './banks.js';
import type { BankType } from './blocks.js';

export interface MemoryHarnessOptions {
  arbiter?: ArbiterOptions;
  budgets?: Partial<Record<BankType, number>>;
}

export interface AssembledContext {
  /** Per-bank rendered sections in fixed order. */
  sections: { bankType: BankType; text: string; tokens: number }[];
  /** Full assembled context string, banks joined in fixed order. */
  text: string;
  tokens: number;
}

const BANK_LABELS: Record<BankType, string> = {
  agenda: 'Agenda (goals and pending work)',
  episodic: 'What I have learned (conventions and takeaways)',
  working: 'Evidence from earlier attempts',
  conversation: 'Recent progress',
};

/**
 * The decoupled memory subsystem: four isolated banks sharing one JEPA salience
 * arbiter. Context is assembled per cycle from ranked bank sections, so what the
 * model sees is non-linear — a compact, salience-ordered projection of everything
 * the agent has stored, not a raw concatenated transcript.
 */
export class MemoryHarness {
  readonly arbiter: JEPASalienceArbiter;
  readonly conversation: BankConversation;
  readonly working: BankWorking;
  readonly episodic: BankEpisodic;
  readonly agenda: BankAgenda;

  constructor(opts: MemoryHarnessOptions = {}) {
    this.arbiter = new JEPASalienceArbiter(opts.arbiter);
    const budgets = opts.budgets ?? {};
    this.conversation = new BankConversation(this.arbiter, budgets.conversation ?? 4_000);
    this.working = new BankWorking(this.arbiter, budgets.working ?? 6_000);
    this.episodic = new BankEpisodic(this.arbiter, budgets.episodic ?? 3_000);
    this.agenda = new BankAgenda(this.arbiter, budgets.agenda ?? 2_000);
  }

  bank(type: BankType) {
    switch (type) {
      case 'conversation':
        return this.conversation;
      case 'working':
        return this.working;
      case 'episodic':
        return this.episodic;
      case 'agenda':
        return this.agenda;
    }
  }

  /** Re-score every bank (call once per cycle before assembling). */
  rescore(nowS?: number): void {
    for (const type of ['agenda', 'episodic', 'working', 'conversation'] as const)
      this.bank(type).rescore(nowS);
  }

  /**
   * Assemble model-facing context: each bank contributes its blocks most-salient
   * first, banks in fixed order (agenda → episodic → working → conversation).
   */
  assemble(): AssembledContext {
    const sections = (['agenda', 'episodic', 'working', 'conversation'] as const).flatMap(
      (type) => {
        const bank = this.bank(type);
        const blocks = bank.ranked();
        if (!blocks.length) return [];
        const body = blocks.map((b) => `- ${b.content}`).join('\n');
        const text = `# ${BANK_LABELS[type]}\n\n${body}`;
        return [{ bankType: type, text, tokens: bank.tokenCount }];
      },
    );
    return {
      sections,
      text: sections.map((s) => s.text).join('\n\n'),
      tokens: sections.reduce((sum, s) => sum + s.tokens, 0),
    };
  }

  stats(): BankStats[] {
    return [
      this.agenda.stats(),
      this.episodic.stats(),
      this.working.stats(),
      this.conversation.stats(),
    ];
  }
}
