import type { Tool } from './types.js';

export type AgentPhase = 'planning' | 'investigate' | 'execution' | 'review';

/**
 * Filter tools available to the LLM compute kernel based on the current finite state machine phase.
 * Prevents invalid tool transitions (e.g. attempting to edit code during pure planning/investigate phases).
 */
export function maskToolsForPhase(tools: readonly Tool[], phase: AgentPhase): readonly Tool[] {
  switch (phase) {
    case 'planning':
    case 'investigate':
      // Only read-only exploration and recall tools allowed
      return tools.filter((t) => t.readOnly);
    case 'review':
      // Review phase only allows read and test/log inspection
      return tools.filter((t) => t.readOnly && t.name !== 'task');
    case 'execution':
    default:
      // Full worker tool set
      return tools;
  }
}
