/**
 * Omnexx Adaptive Runtime Kernel — opt-in hybrid control plane.
 *
 * Deterministic telemetry + local Ollama meta-router. Wire through
 * `createKernelIfEnabled` and `LoopDeps.kernel`; disabled by default.
 */
export {
  AdaptiveRuntimeKernel,
  createKernelIfEnabled,
  type KernelConfig,
  type TurnPlan,
} from './kernel.js';
export { TelemetryMonitor, classifyToolError } from './telemetry.js';
export { StateCheckpointer, pathsFromToolInput } from './checkpoint.js';
export {
  CapabilityIndex,
  LocalMetaRouter,
  parseAllocationJson,
  heuristicAllocate,
} from './ollamaRouter.js';
export {
  turnAllocationSchema,
  ALLOCATION_JSON_SCHEMA,
  MUTATING_TOOL_NAMES,
  isMutatingTool,
  rollbackConstraint,
  type TurnAllocation,
  type TelemetrySnapshot,
  type CapabilityEntry,
  type CheckpointRecord,
  type ModelProfileHints,
} from './types.js';
