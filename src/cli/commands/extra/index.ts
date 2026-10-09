/**
 * Extra CLI commands, one export line per workstream:
 *   export { register as providers } from '../providers.js';
export { register as skills } from '../skills.js';
 * Each export is a CommandRegistrar (see ./types.ts). Keep lines sorted by export name.
 */
export { register as mcp } from '../mcp.js';
export { register as models } from '../models.js';
export { register as providers } from '../providers.js';
export { register as skills } from '../skills.js';
