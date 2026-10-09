# Project instructions and skills

W10 loads the repository's instruction files into the prompt prefix and discovers skills the
agent can load on demand. Core modules: `src/instructions/**` and `src/tools/extra/skill.ts`.

## Instruction files

`loadInstructions(repoRoot, cwdInRepo)` reads, in this precedence order (highest first):

1. `OMNEXX.md` — omnexx's own project file.
2. `AGENTS.md` — the cross-tool standard.
3. `CLAUDE.md` — Claude Code's project file.
4. `.cursor/rules/*.mdc` — Cursor rules; the YAML frontmatter block is stripped, files are read
   in sorted filename order.
5. `.github/copilot-instructions.md` — GitHub Copilot.
6. **Nested** `AGENTS.md` / `CLAUDE.md` in every parent directory of `cwdInRepo` (the directory
   the agent is working in), shallow first, `AGENTS.md` before `CLAUDE.md` per directory. A
   `cwdInRepo` outside the repo contributes nothing.

Rules:

- Empty or unreadable files are skipped, never an error.
- The combined render is capped at **8k tokens** (the 3-chars/token estimate from
  `src/core/tokens.ts`). Files are cut from the _end_ of the order above — deepest nested first,
  then copilot, Cursor, `CLAUDE.md`, `AGENTS.md`, `OMNEXX.md` last — and every cut file is named
  in a `> Note: project instructions were truncated …` footer. A single file larger than the
  whole budget keeps its head, marked `… (truncated)`.
- Everything is sorted and order-fixed, so the same repo + cwd renders **byte-identical** text
  and the cached prompt prefix stays stable (no timestamps, no `readdir` order dependence).

## API

```ts
const loaded = await loadInstructions(repoRoot, cwdInRepo);
const text = renderInstructions(loaded); // or renderInstructions() after a load; '' when none
```

- `renderInstructions()` with no arguments uses the result of the last `loadInstructions` call —
  this is the form `src/agent/prompts.ts` will call (see the INTEGRATION entry in
  `docs/integration-notes.md`). It returns `''` when nothing was loaded, so callers can skip the
  block.
- `loaded.truncated` lists every file that was cut, lowest precedence first.

## Skills

Skills are folders with a `SKILL.md`, in Claude Code's format: a flat YAML frontmatter block with
`name` and `description`, then the body. When `name` is missing the directory name is used. They
are read in place, never copied, from these folders (a later one shadows a skill of the same name
in an earlier one):

1. Claude Code's user skills, `~/.claude/skills` (when `[skills] import_claude`, on by default)
2. every folder in `[skills] dirs` (`~` is the home folder; relative paths are from the repo)
3. omnexx user skills, `~/.config/omnexx/skills` (honours `OMNEXX_CONFIG_HOME`, `XDG_CONFIG_HOME`)
4. the repo's `.claude/skills` (when `import_claude`), then the repo's `.omnexx/skills`

Set them up with `omnexx skills` or `/skills` in the TUI:

| Command                             | What it does                                                        |
| ----------------------------------- | ------------------------------------------------------------------- |
| `omnexx skills list`                | every skill, where it comes from, its description                   |
| `omnexx skills add <path\|git-url>` | copy a skill, a folder of them, or a repo's `skills/` into your own |
| `omnexx skills remove <name>`       | remove one you added (skills from other sources are left alone)     |
| `omnexx skills import`              | show the Claude Code skills in use                                  |

```ts
const roots = {
  repoRoot,
  env,
  dirs: config.skills.dirs,
  importClaude: config.skills.import_claude,
};
const list = await listSkills(roots); // [{name, description}], sorted by name
const skill = await loadSkill('commit-style', roots); // body ≤ 6k tokens, frontmatter stripped
```

- Bodies over **6k tokens** are cut with a `… (truncated)` note; `skill.truncated` says so.
- Both functions are deterministic: sorted directory scans, fixed folder order.

## The `skill` tool

`src/tools/extra/skill.ts` registers `skill({ name })` (read-only) through the extra-tool barrel.
It always loads. Its description lists every available skill (name and description, cut to ~6k
characters), built once per cycle, so the model knows what exists without guessing; the list only
changes the prompt prefix when skills are added or removed. Unknown names return an error listing
the available skills.

Wiring notes (who calls what) live in `docs/integration-notes.md` under **W10**; hook config and
semantics live in [hooks.md](hooks.md).
