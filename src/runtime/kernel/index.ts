/**
 * Omnexx Adaptive Runtime Kernel — hybrid control plane (on by default).
 *
 * Deterministic telemetry + local Ollama meta-router with heuristic/TF-IDF fallback.
 * Wire through `createKernelIfEnabled` and `LoopDeps.kernel`; set `[kernel] enabled = false` to opt out.
 */
export {
  AdaptiveRuntimeKernel,
  createKernelIfEnabled,
  type KernelConfig,
  type TurnPlan,
} from './kernel.js';
export { TelemetryMonitor, classifyToolError } from './telemetry.js';
export { StateCheckpointer, pathsFromToolInput } from './checkpoint.js';
export { MemoryVfs } from './vfs.js';
export { runMcts, scoreBranch } from './mcts.js';
export { ContextGarbageCollector, compactAsync } from './contextGc.js';
export {
  CapabilityIndex,
  LocalMetaRouter,
  parseAllocationJson,
  heuristicAllocate,
  multiSampleAllocations,
  allocationSimilarities,
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

export {
  CapabilityCatalog,
  createCatalogTools,
  syntheticCatalog,
  type CatalogEntry,
} from './catalog.js';
export {
  loadRegistry,
  fetchLiveRegistry,
  installSuggestion,
  MCP_REGISTRY_URL,
  type RegistrySnapshot,
  type RegistryServerRecord,
} from './registry.js';
export {
  discoverLocalMcpServers,
  discoverLocalSkills,
  searchSkillMd,
  type DiscoveredLocal,
} from './discover.js';
export {
  mcpCapabilityRuntime,
  toolsFromMcpInfos,
  type CapabilityRuntime,
} from './liveMount.js';
export { mergeWithFloor } from './registry.js';

