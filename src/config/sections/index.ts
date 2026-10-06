/**
 * Extra top-level config sections, one export line per workstream:
 *   export { browser } from './browser.js';
 * The export name is the TOML table name; the value is a zod schema with a default
 * (`z.strictObject({...}).prefault({})`) so configs without the table still parse.
 * Keep lines sorted by export name.
 */
export { beyond } from './beyond.js';
export { browser } from './browser.js';
export { mcp } from './mcp.js';
export { router } from './router.js';
export { web } from './web.js';
