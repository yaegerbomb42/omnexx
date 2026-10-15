# appconfig

Typed configuration for the service. TypeScript run directly by Node >= 22.18 (erasable syntax
only: no enums, namespaces or constructor parameter properties). `npm test` runs `node --test`.

The schema lives in `src/schema.ts`. `loadConfig` in `src/load.ts` builds the config.
