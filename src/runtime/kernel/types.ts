import { z } from 'zod';

/** Per-turn allocation from the meta-router (or deterministic fallback). */
export const turnAllocationSchema = z.strictObject({
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  reasoningMode: z.enum(['zero-shot', 'cot', 'reflexion', 'mcts']),
  mctsBranchFactor: z.number().int().min(2).max(8).optional(),
  activeRoles: z
    .array(z.enum(['executor', 'planner', 'verifier', 'adversarial_critic']))
    .min(1)
    .max(4),
  mountedTools: z.array(z.string().min(1)).max(15),
  mountedSkills: z.array(z.string().min(1)).max(8),
  maxTokensTurn: z.number().int().positive().max(128_000),
  allowCodeModeBatching: z.boolean(),
  blastRadius: z.enum(['low', 'medium', 'high']),
});

export type TurnAllocation = z.infer<typeof turnAllocationSchema>;

/** JSON Schema subset Ollama `format` accepts for structured output. */
export const ALLOCATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'integer', enum: [0, 1, 2, 3] },
    reasoningMode: { type: 'string', enum: ['zero-shot', 'cot', 'reflexion', 'mcts'] },
    mctsBranchFactor: { type: 'integer', minimum: 2, maximum: 8 },
    activeRoles: {
      type: 'array',
      items: { type: 'string', enum: ['executor', 'planner', 'verifier', 'adversarial_critic'] },
      minItems: 1,
      maxItems: 4,
    },
    mountedTools: { type: 'array', items: { type: 'string' }, maxItems: 15 },
    mountedSkills: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    maxTokensTurn: { type: 'integer', minimum: 1, maximum: 128000 },
    allowCodeModeBatching: { type: 'boolean' },
    blastRadius: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: [
    'tier',
    'reasoningMode',
    'activeRoles',
    'mountedTools',
    'mountedSkills',
    'maxTokensTurn',
    'allowCodeModeBatching',
    'blastRadius',
  ],
  additionalProperties: false,
} as const;

export interface TelemetrySnapshot {
  frictionScore: number;
  contextPressure: number;
  epistemicUncertainty: number;
  consecutiveFailures: number;
  lastToolSignature: string;
  turn: number;
}

export interface ModelProfileHints {
  /** Max context window tokens for the active base model. */
  maxWindow: number;
  /** Fraction of maxWindow that is the attention degradation ceiling (default 0.65). */
  attentionCeiling: number;
  /** Soft cap on how many tools to mount for this model class. */
  maxMountedTools: number;
}

export interface CapabilityEntry {
  kind: 'tool' | 'skill';
  id: string;
  name: string;
  description: string;
  triggerConditions?: string | undefined;
  /** Embedding vector when Ollama embeddings succeeded; absent under keyword fallback. */
  embedding?: number[] | undefined;
  /** Bag-of-words for BM25/TF-IDF fallback. */
  tokens: string[];
}

export interface AllocateRequest {
  objective: string;
  stateDelta: string;
  telemetry: TelemetrySnapshot;
  candidates: readonly CapabilityEntry[];
  profile: ModelProfileHints;
}

export interface CheckpointRecord {
  nodeId: string;
  headSha: string;
  /** Relative path → UTF-8 content at snapshot time (empty string means the file was absent). */
  files: Record<string, string>;
  createdAt: number;
  conversationLength: number;
}

export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'str_replace',
  'multi_edit',
  'replace_lines',
  'apply_patch',
  'patch',
  'bash',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name) || name.startsWith('mcp_');
}

/** One-line constraint injected after a kernel rollback. */
export function rollbackConstraint(nodeId: string, reason: string, attemptHint: string): string {
  return `[KERNEL ROLLBACK]: Branch ${nodeId} failed due to ${reason}. Constraint: Do not repeat ${nodeId}; attempt ${attemptHint}.`;
}
