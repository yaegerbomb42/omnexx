import { describe, expect, it } from 'vitest';
import {
  BankConversation,
  JEPASalienceArbiter,
  MemoryBank,
  MemoryHarness,
  createBlock,
} from '../../../../src/core/memory/index.js';

const NOW = 1_000_000;

/** Insert and assert the block was accepted (under-budget content). */
function mustInsert(bank: MemoryBank, content: string, opts?: { isPinned?: boolean }) {
  const block = bank.insert(content, opts);
  if (!block) throw new Error(`insert rejected: ${content.slice(0, 40)}`);
  return block;
}

describe('createBlock', () => {
  it('assigns id, timestamp, token count and defaults', () => {
    const b = createBlock('working', 'hello world', { timestamp: NOW });
    expect(b.id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.bankType).toBe('working');
    expect(b.timestamp).toBe(NOW);
    expect(b.tokenCount).toBeGreaterThan(0);
    expect(b.isPinned).toBe(false);
    expect(b.embedding).toBeUndefined();
  });
});

describe('JEPASalienceArbiter', () => {
  it('encodes deterministically to unit vectors', () => {
    const arbiter = new JEPASalienceArbiter({ latentDim: 64 });
    const a = arbiter.encode('fix the flaky test in verify/gates');
    const b = arbiter.encode('fix the flaky test in verify/gates');
    expect(a.length).toBe(64);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });

  it('scores first observation as maximally surprising', () => {
    const arbiter = new JEPASalienceArbiter();
    const latent = arbiter.encode('anything at all');
    expect(arbiter.predictionError('working', latent)).toBe(1);
  });

  it('repeated similar content becomes predictable and loses salience', () => {
    const arbiter = new JEPASalienceArbiter({ recencyHalfLifeS: 10_000 });
    const similar = 'run vitest on the verify package and check the gates output';
    for (let i = 0; i < 20; i++) arbiter.observe('working', arbiter.encode(similar));
    const scoreSimilar = arbiter.score('working', arbiter.encode(similar), NOW, NOW);
    const scoreNovel = arbiter.score(
      'working',
      arbiter.encode('the quarterly biscuit forecast exploded sideways'),
      NOW,
      NOW,
    );
    expect(scoreNovel).toBeGreaterThan(scoreSimilar);
  });

  it('fresh blocks outscore stale ones given equal surprise', () => {
    const arbiter = new JEPASalienceArbiter({ recencyHalfLifeS: 100 });
    const latent = arbiter.encode('a block of text');
    const fresh = arbiter.score('conversation', latent, NOW, NOW);
    const stale = arbiter.score('conversation', latent, NOW - 1_000, NOW);
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe('MemoryBank', () => {
  const makeBank = (budget = 200) => {
    const arbiter = new JEPASalienceArbiter();
    return new MemoryBank('working', budget, arbiter);
  };

  it('inserts and indexes blocks by id', () => {
    const bank = makeBank();
    const block = mustInsert(bank, 'stdout: 42 tests passed');
    expect(bank.get(block.id)).toBe(block);
    expect(bank.size).toBe(1);
    expect(bank.tokenCount).toBe(block.tokenCount);
    expect(block.embedding).toBeDefined();
    expect(block.salience).toBeGreaterThan(0);
  });

  it('rejects content larger than the whole budget', () => {
    const bank = makeBank(10);
    expect(bank.insert('x'.repeat(1_000))).toBeUndefined();
    expect(bank.size).toBe(0);
  });

  it('evicts lowest-salience unpinned blocks non-linearly to fit budget', () => {
    const arbiter = new JEPASalienceArbiter();
    const bank = new MemoryBank('working', 120, arbiter);
    // Teach the bank a repetitive pattern so similar inserts score low.
    const filler = 'npm test passed for the verify gates suite once more';
    const first = mustInsert(bank, filler);
    for (let i = 0; i < 10; i++) arbiter.observe('working', arbiter.encode(filler));
    bank.rescore();
    // A novel block must now outrank the stale repetitive one.
    const novel = mustInsert(bank, 'kernel panic while parsing the biscuit manifest');
    expect(novel.salience).toBeGreaterThan(first.salience);
    // Squeeze the budget: the repetitive block should be evicted, novel kept.
    while (bank.tokenCount + novel.tokenCount <= bank.tokenBudget && bank.size < 4) {
      if (!bank.insert(filler)) break;
    }
    for (let i = 0; i < 6; i++) bank.insert(`${filler} ${i}`);
    expect(bank.tokenCount).toBeLessThanOrEqual(bank.tokenBudget);
    expect(bank.get(novel.id)).toBeDefined();
    expect(bank.get(first.id)).toBeUndefined();
  });

  it('never evicts pinned blocks', () => {
    const bank = makeBank(60);
    const pinned = mustInsert(bank, 'keep me no matter what', { isPinned: true });
    pinned.salience = 0; // even zero salience survives
    for (let i = 0; i < 8; i++) bank.insert(`new shiny observation number ${i} arrives`);
    expect(bank.get(pinned.id)).toBeDefined();
  });

  it('remove and stats stay consistent', () => {
    const bank = makeBank();
    const a = mustInsert(bank, 'alpha');
    bank.insert('beta');
    expect(bank.remove(a.id)).toBe(true);
    expect(bank.remove(a.id)).toBe(false);
    const stats = bank.stats();
    expect(stats.blocks).toBe(1);
    expect(stats.tokens).toBe(bank.tokenCount);
  });
});

describe('MemoryHarness', () => {
  it('exposes four isolated banks with independent budgets', () => {
    const h = new MemoryHarness();
    h.conversation.insert('user: please fix the build');
    h.working.insert('tool result: tsc --noEmit failed');
    h.episodic.insert('project convention: always run npm run check');
    h.agenda.insert('goal: green CI on the next branch');
    const stats = h.stats();
    expect(stats.map((s) => s.bankType).sort()).toEqual([
      'agenda',
      'conversation',
      'episodic',
      'working',
    ]);
    expect(stats.every((s) => s.blocks === 1)).toBe(true);
  });

  it('assembles context in fixed bank order, salience-ranked within banks', () => {
    const h = new MemoryHarness();
    const stale = mustInsert(h.conversation, 'old chit chat about lunch');
    const fresh = mustInsert(h.conversation, 'user just asked to ship the release');
    stale.salience = 0.1;
    fresh.salience = 0.9;
    h.agenda.insert('goal: ship the release');
    const ctx = h.assemble();
    expect(ctx.sections.map((s) => s.bankType)).toEqual(['agenda', 'conversation']);
    const conv = ctx.sections.find((s) => s.bankType === 'conversation');
    if (!conv) throw new Error('conversation section missing');
    expect(conv.text.indexOf('ship the release')).toBeLessThan(conv.text.indexOf('lunch'));
    expect(ctx.tokens).toBeGreaterThan(0);
  });

  it('banks do not bleed into each other', () => {
    const h = new MemoryHarness();
    const w = mustInsert(h.working, 'stderr from the test run');
    expect(h.conversation.get(w.id)).toBeUndefined();
    expect(h.episodic.get(w.id)).toBeUndefined();
    expect(h.agenda.get(w.id)).toBeUndefined();
  });

  it('keeps each bank within its own token budget under load', () => {
    const h = new MemoryHarness({
      budgets: { conversation: 100, working: 100, episodic: 100, agenda: 100 },
    });
    for (let i = 0; i < 40; i++) {
      h.conversation.insert(`turn ${i}: hello there ${'x'.repeat(i)}`);
      h.working.insert(`stdout chunk ${i} ${'y'.repeat(i)}`);
      h.episodic.insert(`takeaway ${i}`);
      h.agenda.insert(`todo item ${i}`);
    }
    for (const s of h.stats()) expect(s.tokens).toBeLessThanOrEqual(s.tokenBudget);
  });

  it('shares one arbiter across banks and tracks observations per bank', () => {
    const h = new MemoryHarness();
    const conv = new BankConversation(h.arbiter);
    h.working.insert('some tool output');
    conv.insert('a user message');
    expect(h.arbiter.observationCount('working')).toBe(1);
    expect(h.arbiter.observationCount('conversation')).toBe(1);
    expect(h.arbiter.observationCount('agenda')).toBe(0);
  });
});
