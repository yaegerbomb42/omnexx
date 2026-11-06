/**
 * Extra CLI commands, one export line per workstream:
 *   export { register as providers } from '../providers.js';
export { register as skills } from '../skills.js';
 * Each export is a CommandRegistrar (see ./types.ts). Keep lines sorted by export name.
 */
export { register as agentCards } from '../agent-cards.js';
export { register as connect } from '../connect.js';
export { register as daemon } from '../daemon.js';
export { register as kernel } from '../kernel-status.js';
export { register as mcp } from '../mcp.js';
export { register as migrate } from '../../migrate.js';
export { register as models } from '../models.js';
export { register as providers } from '../providers.js';
export { register as queue } from '../queue.js';
export { register as review } from '../review.js';
export { register as skills } from '../skills.js';
export { register as system1 } from '../system1-status.js';
export { register as usage } from '../usage.js';
