/**
 * Extra top-level config sections, one export line per workstream:
 *   export { browser } from './browser.js';
 * The export name is the TOML table name; the value is a zod schema with a default
 * (`z.strictObject({...}).prefault({})`) so configs without the table still parse.
 * Keep lines sorted by export name.
 */
export { agents } from './agents.js';
export { autonomous } from './autonomous.js';
export { beyond } from './beyond.js';
export { browser } from './browser.js';
export { hooks } from './hooks.js';
export { mcp } from './mcp.js';
export { review } from './review.js';
export { router } from './router.js';
export { search } from './search.js';
export { security } from './security.js';
export { skills } from './skills.js';
export { web } from './web.js';
