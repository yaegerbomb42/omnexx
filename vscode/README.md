# omnexx for VS Code

A chat panel for the [omnexx](https://omnexx.org) coding agent, right in your sidebar: chat
with it, have it plan, or let it run on its own for hours, and watch every step.

![The omnexx chat panel mid-task](https://raw.githubusercontent.com/yaegerbomb42/omnexx/main/vscode/media/screenshot.png)

## Needs

Nothing else: omnexx is built into the extension. If you also install the CLI (`npm i -g omnexx`
or `brew install yaegerbomb42/omnexx/omnexx`) and it's the same version or newer, the panel uses
that one, so the terminal and the panel share one install. `omnexx.path` overrides both.

## The chat panel

Open it from the omnexx icon in the activity bar, or press `Cmd+Alt+O` (`Ctrl+Alt+O`).

- **Session stats**: uptime, model turns, tokens (hover for input, output and cache hits), cost,
  and how full the context is.
- **Modes**: **Act** works turn by turn with you, **Plan** investigates and proposes a plan
  without editing, **Autonomous** starts a long run in the background.
- **Approvals**: **Ask first** shows Allow / Deny before omnexx goes outside the repo or runs a
  guarded command. **Auto-approve** goes ahead (hard-blocked commands stay blocked). Set the
  default with `omnexx.autoApprove`.
- **Trajectory**: the agent's step list as a timeline, with the active step's progress and what
  it is doing right now.
- **Activity inline**: actions, thinking and notes show in the conversation as they happen,
  with an "est. 5s" countdown while the model answers.
- **Composer**: Enter sends, Shift+Enter adds a line. While the agent works, a message steers it
  at its next step; pause and stop sit next to the input, and Esc stops.
- **Models and providers**: click the model name to switch, or add an API key or any
  OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…). The gear has the rest: project
  and user settings, the approval default, and restart.
- File paths in replies open in the editor.

The panel drives `omnexx chat-server`, the same session as the terminal UI, so the
conversation carries over: `omnexx -c` in a terminal continues it.

## History

Below the chat, **History** lists past chats and runs for the open folders under Today,
Yesterday and Earlier, named by what was asked. Click a chat to reopen its transcript and carry
on; a run shows its milestones and tasks, and you can watch, pause, resume or stop it.

## Settings

| Setting                 | Default | Meaning                                     |
| ----------------------- | ------- | ------------------------------------------- |
| `omnexx.path`           | (PATH)  | The omnexx executable                       |
| `omnexx.autoApprove`    | `false` | Start chats in auto-approve mode            |
| `omnexx.showAllRuns`    | `false` | List runs from every repository             |
| `omnexx.refreshSeconds` | `5`     | How often a live run's todo list is re-read |

## Develop

From this folder: `npm run build`, then press F5 in VS Code with this folder open. `npm run
package` builds a `.vsix`.
