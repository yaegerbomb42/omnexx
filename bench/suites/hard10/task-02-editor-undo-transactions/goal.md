# Task: Add Undo/Redo and Transactions to the Editor

`createEditor()` in `src/editor.ts` is a headless text-editing model. Add history to it. Keep the
existing methods and behavior, and add these to the `Editor` returned by
`createEditor(initial?: string, options?: { historyLimit?: number })`:

- `undo(): boolean` reverts the most recent history step and returns `true`, or returns `false`
  (and changes nothing) when there is nothing to undo.
- `redo(): boolean` re-applies the most recently undone step, same return convention.
- `canUndo(): boolean` and `canRedo(): boolean`.
- `transaction(fn: () => void): void` runs `fn`; every edit made inside it is one history step.
  Nested transactions fold into the outermost one. If `fn` throws, all edits made inside the
  transaction are rolled back, no history step is recorded, listeners are not called, and the
  error is re-thrown.

Rules:

- Every `insert`/`delete` outside a transaction is its own step.
- An edit that changes nothing (inserting `''`, deleting length 0, deleting at the end of the
  text) records no step and does not notify listeners.
- `delete` past the end of the text deletes only what exists; undoing it restores exactly the
  original text.
- Making a new edit after an undo discards the redo stack.
- `onChange` listeners are called exactly once per committed outermost transaction, once per
  plain edit, and once per successful `undo`/`redo`, with the new text.
- History keeps at most `historyLimit` steps (default 100); when full, the oldest step is
  dropped.

Spread the work sensibly over `src/` (commands need to know how to invert themselves). Add tests.

## Success Criteria

- `npm test` passes (Node >= 22.18 runs the `.ts` files directly; no build step)
- The new API behaves exactly as specified above
