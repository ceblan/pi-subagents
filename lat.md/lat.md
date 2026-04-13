This directory defines the high-level concepts, business logic, and architecture of this project using markdown. It is managed by [lat.md](https://www.npmjs.com/package/lat.md) — a tool that anchors source code to these definitions. Install the `lat` command with `npm i -g lat.md` and run `lat --help`.

## Files

Each file below documents a distinct aspect of the pi-subagents architecture.

- [[overview]] — Project purpose, installation, execution modes, and key design principles
- [[architecture]] — Module map, state management, process model, and dependency graph
- [[agents]] — Agent config, scopes, discovery, chain configs, and management actions
- [[execution]] — Execution modes (single/chain/parallel), process spawning, sync vs async, fork context, and worktree isolation
- [[chain]] — Chain pipeline, variables, directory, step behavior resolution, chain files, and clarify TUI
- [[skills]] — Skill discovery, resolution, injection format, and runtime overrides
- [[async-observability]] — Async run files, status tool, widget, event bus, and run history
- [[worktree-isolation]] — Git worktree lifecycle, diff capture, output aggregation, and constraints
- [[ui]] — Agents Manager overlay, chain clarify TUI, text editor, result rendering, and slash commands
- [[artifacts]] — Per-run artifact files, configuration, and cleanup
- [[tests]] — Unit, integration, and e2e test suites and test support infrastructure
- [[journals]] — Daily session journals capturing prompts, tool usage, and notable debugging work
