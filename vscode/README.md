# omnexx for VS Code

<p align="center">
  <b>Set a goal, walk away, come back to commits.</b><br>
  An autonomous coding agent that works in your repository for hours, tests every change, and keeps only what passes.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/yaegerbomb42/omnexx/main/docs/assets/demo.gif" alt="omnexx in action" width="780">
</p>

## How to Use

1. **Open the panel**: Click the **omnexx** icon in the Activity Bar or press `Cmd+Alt+O` (`Ctrl+Alt+O`).
2. **Select a model**: Click the model picker. Use **local Ollama (zero setup required)**, Anthropic, OpenAI, or OpenRouter.
3. **Pick a mode & run**: Type your task and select how you want omnexx to work:

| Mode           | What it does                                                         | Best for                             |
| :------------- | :------------------------------------------------------------------- | :----------------------------------- |
| **Plan**       | Explores codebase and outlines a complete plan without editing files | Pre-flight review & architecture     |
| **Act**        | Turn-by-turn interactive pairing with approval prompts               | Targeted features & iterative fixes  |
| **Autonomous** | Runs multi-hour unattended tasks in the background                   | Large refactors & deep backlog items |

<p align="center">
  <img src="https://raw.githubusercontent.com/yaegerbomb42/omnexx/main/vscode/media/panel.png" alt="omnexx sidebar panel mid-task" width="380">
  <img src="https://raw.githubusercontent.com/yaegerbomb42/omnexx/main/vscode/media/model-picker.png" alt="omnexx model picker" width="380">
</p>

## Highlights

- **Zero-Config Local Models**: Automatically detects and configures the best coding model in your local Ollama with 32k context. No API keys needed.
- **Safety First**: Every kept change passes your project's tests, linting, and typechecks; failures are rolled back automatically.
- **Live Trajectory**: Watch the real-time timeline of tasks, active sub-steps, token costs, and context utilization.
- **Terminal Sync**: Built-in engine shares state with the CLI. Switch seamlessly between VS Code and `omnexx -c` in your terminal.
- **Granular Approvals**: Toggle between **Ask first** (confirm commands and external paths) and **Auto-approve**.

## Configuration

| Setting                 | Default  | Description                                           |
| :---------------------- | :------- | :---------------------------------------------------- |
| `omnexx.path`           | `(auto)` | Path to the `omnexx` executable (built-in by default) |
| `omnexx.autoApprove`    | `false`  | Enable auto-approve mode for file edits and commands  |
| `omnexx.showAllRuns`    | `false`  | Show history runs across all repositories             |
| `omnexx.refreshSeconds` | `5`      | Refresh frequency (in seconds) for active run tasks   |

## CLI Companion

The VS Code extension includes omnexx out of the box. To also install the standalone CLI:

```bash
brew install yaegerbomb42/omnexx/omnexx  # macOS / Linux
npm i -g omnexx                         # Anywhere with Node 22+
```
