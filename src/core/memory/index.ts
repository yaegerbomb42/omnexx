/**
 * Non-linear, multi-bank dynamic context management (JEPA memory harness).
 *
 * Instead of one monolithic, linear transcript, context lives in four isolated
 * banks. Inclusion and eviction are governed by a lightweight Joint-Embedding
 * Predictive Architecture (JEPA) latent salience arbiter — not reactive token
 * heuristics and not LLM summarization.
 */

export { createBlock } from './blocks.js';
export type { BankType, ContextBlock } from './blocks.js';
export { JEPASalienceArbiter, type ArbiterOptions } from './arbiter.js';
export {
  BankConversation,
  BankWorking,
  BankEpisodic,
  BankAgenda,
  MemoryBank,
  type BankStats,
} from './banks.js';
export { MemoryHarness, type MemoryHarnessOptions, type AssembledContext } from './harness.js';
