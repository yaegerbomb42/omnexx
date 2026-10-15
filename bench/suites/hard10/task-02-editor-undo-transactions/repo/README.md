# tiny-editor

A headless text-editing model (no UI). Plain TypeScript run directly by Node (type stripping,
Node >= 22.18), so only erasable syntax works: no enums, namespaces or constructor parameter
properties. `npm test` runs `node --test`.

- `src/document.ts`: an immutable text buffer.
- `src/commands.ts`: edit operations applied to a document.
- `src/editor.ts`: the public API, `createEditor()`.
