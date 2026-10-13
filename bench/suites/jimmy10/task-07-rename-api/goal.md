# Task: Rename an API Across the Codebase

Rename the function `getUsr` to `getUser` and the module `src/usr.js` to `src/user.js`
everywhere. Every caller must use the new names and nothing may import the old path. Keep a
deprecated re-export: `src/usr.js` should re-export `getUser` as `getUsr` for one release.

## Success Criteria

- `npm test` passes
- No file other than `src/usr.js` mentions `getUsr`
