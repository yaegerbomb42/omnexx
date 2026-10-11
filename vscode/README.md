# omnexx for VS Code

Start [omnexx](https://omnexx.org) runs from the editor, let them work for hours, and watch the
todo list move in the sidebar.

## Needs

The omnexx CLI, version 0.5.0 or later: `npm i -g omnexx`. Set `omnexx.path` if it isn't on
your PATH.

## What it does

- **Runs sidebar** (the omnexx icon in the activity bar): the runs started from the open folders,
  newest first. Expand a run for its milestones and tasks: done, in progress, parked, and the
  task it's working on now. A live run refreshes every few seconds.
- **Start Run**: asks for a goal and runs `omnexx run --detach <goal>` in a terminal. The run
  keeps going after you close the terminal or VS Code.
- **Autonomous for N Hours**: asks for a goal, a duration (`8h`, `2d`, `1h30m`) and an optional
  gate command, then runs `omnexx run --detach --for <duration> [--gate <cmd>] <goal>`.
- **Open Chat in Terminal**: the interactive omnexx session in the first open folder.
- Per run: **Watch in Terminal** (`omnexx watch`), **Pause**, **Resume** and **Stop**.

The extension only calls the CLI (`omnexx runs --json`, `omnexx plan --json`); it never reads
run files directly or calls a model itself.

## Settings

| Setting                 | Default | Meaning                                     |
| ----------------------- | ------- | ------------------------------------------- |
| `omnexx.path`           | (PATH)  | The omnexx executable                       |
| `omnexx.showAllRuns`    | `false` | List runs from every repository             |
| `omnexx.refreshSeconds` | `5`     | How often a live run's todo list is re-read |

## Develop

From this folder: `npm run build`, then press F5 in VS Code with this folder open (or run
`code --extensionDevelopmentPath=$PWD`). `npm run package` builds a `.vsix`.
