import { z } from 'zod';

export type MutationTarget = 'prompt' | 'tool_hint' | 'config';

export interface FailureSymptom {
  turn: number;
  kind: 'tool_error' | 'doom_loop' | 'gate_failure' | 'budget_exhausted' | 'cache_thrashing';
  detail: string;
  tool?: string;
  command?: string;
  traceSnippet?: string;
}

export interface MutationProposal {
  target: MutationTarget;
  file: string;
  rationale: string;
  diffPatch: string;
}

export interface EvolutionResult {
  generation: number;
  symptom: FailureSymptom;
  mutation: MutationProposal;
  status: 'accepted' | 'rejected';
  rejectionReason?: string;
}

export const failureSymptomSchema = z.object({
  turn: z.number().int().nonnegative(),
  kind: z.enum(['tool_error', 'doom_loop', 'gate_failure', 'budget_exhausted', 'cache_thrashing']),
  detail: z.string(),
  tool: z.string().optional(),
  command: z.string().optional(),
  traceSnippet: z.string().optional(),
});

export const mutationProposalSchema = z.object({
  target: z.enum(['prompt', 'tool_hint', 'config']),
  file: z.string(),
  rationale: z.string(),
  diffPatch: z.string(),
});
