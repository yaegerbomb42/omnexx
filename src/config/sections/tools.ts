import { z } from 'zod';

/**
 * [tools]: tool discovery and loading behavior.
 */
export const tools = z
  .strictObject({
    /**
     * Tool discovery mode:
     * - "lazy" (default): send only a compact index of tool groups; load full definitions on demand via request_tools
     * - "full": send all tool definitions to the provider every request (the pre-lazy behavior)
     */
    discovery: z.enum(['full', 'lazy']).default('lazy'),
    /**
     * Maximum number of tool groups to keep loaded before unloading the least recently used (optional LRU cap).
     * When unset, loaded groups stay loaded for the session.
     */
    max_loaded_groups: z.number().int().positive().optional(),
  })
  .prefault({});
