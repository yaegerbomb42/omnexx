/**
 * Placeholder for the `vscode` module, which only exists inside the editor. Tests that touch the
 * extension `vi.mock('vscode', …)` with their own fakes; this alias only lets vitest resolve the
 * import when it walks the module graph (e.g. `vitest --changed` / `vitest related`).
 */
export {};
