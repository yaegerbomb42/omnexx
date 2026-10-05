# Task: Refactor Legacy Code to Modern TypeScript

## Goal

Refactor the `src/legacy.js` file from legacy JavaScript to modern, strict TypeScript. The file uses old patterns like `var`, callback-based async, and lacks type annotations.

## Repository

A small project with a legacy JavaScript file that needs modernization.

## Success Criteria

- File renamed to `src/legacy.ts` with proper TypeScript syntax
- `npm run typecheck` passes with zero errors
- `npm test` passes (tests updated to match new API if needed)
- Modern patterns used: `const`/`let`, `async`/`await`, type annotations, ESM imports
