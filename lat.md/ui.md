# UI Components

The extension provides interactive TUI components built on pi-tui. All overlays are rendered through the pi extension API with a consistent key-binding model.

## Agents Manager Overlay

The Agents Manager is opened by pressing `Ctrl+Shift+A` or running `/agents`. It is orchestrated by [[agent-manager.ts]] which owns screen routing and CRUD dispatch. All screens communicate by returning typed `ManagerResult` actions.

### Screens

Each screen is a separate module with its own render and input handler functions.

- **List** ([[agent-manager-list.ts]]): Browse agents and chains with live search/filter, scope badges, and multi-select via `Tab`. `Ctrl+N` creates from template, `Ctrl+K` clones, `Ctrl+D`/`Del` deletes, `Ctrl+R` launches, `Ctrl+P` opens parallel builder.
- **Detail** ([[agent-manager-detail.ts]]): Shows resolved system prompt, frontmatter fields, and last-5 run history. Press `e` to edit, `Enter` to go to task input.
- **Edit** ([[agent-manager-edit.ts]]): Picker-driven editing of model (fuzzy search), thinking level, skills (multi-select), and full-screen prompt editor. Saves directly to the agent file.
- **Chain Detail** ([[agent-manager-chain-detail.ts]]): Renders chain step flow with dependency visualization (`✓scout → ●planner`).
- **Parallel Builder** ([[agent-manager-parallel.ts]]): Slot-based editor for building parallel execution with per-slot task overrides. Same agent can appear multiple times.
- **Task Input** ([[agent-manager-detail.ts#renderTaskInput]]): Enter task and toggle skip-clarify before launching.

## Chain Clarify TUI

[[chain-clarify.ts]] shows chain steps before execution and supports single, chain, and parallel modes.

Keys: `e` edit task, `m` model, `t` thinking, `s` skills, `b` toggle async, `w` output file, `r` reads, `p` progress, `S` save to agent file, `W` save to `.chain.md`. Press `Enter` to run, `Esc` to cancel.

## Text Editor

[[text-editor.ts]] provides a reusable word-navigation text editor used by both the chain clarify and agents manager overlays.

Features: word-boundary cursor movement (`Alt+←→`), page navigation (`Page Up/Down`), `Home`/`End` per display line, `Ctrl+Home`/`Ctrl+End` for document start/end, `Alt+Backspace` for word deletion, and multi-line paste.

## Result Rendering

`renderSubagentResult` in [[render.ts]] produces the tool result component shown in the conversation.

For sync chains, it renders step status icons (`✓`, `●`, `○`, `✗`), current tool, recent output lines, token counts, and duration. For parallel runs, it renders per-task cards. Supports expanded (`Ctrl+O`) and collapsed views.

Live progress during slash command execution is tracked in [[slash-live-state.ts]] via versioned snapshots that drive re-render without rebuilding the full component tree.

## Slash Commands

Slash commands are registered in [[slash-commands.ts]] and bridge to the executor via [[slash-bridge.ts]].

Tab completion on agent names is provided via `discoverAgents`. Per-step tasks and inline overrides (`[key=value,...]`) are parsed from the slash command text before routing to the executor.

## Async Status Overlay

[[subagents-status.ts]] renders a read-only overlay listing active and recent runs. Rows show run ID prefix, mode, state, step progress, duration, and agent names. Auto-refreshes every 2 seconds while open.
