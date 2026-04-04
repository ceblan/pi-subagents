# Architecture

The extension is organized into clearly scoped modules. Each module has a single responsibility; cross-module coupling flows through the `types.ts` shared interfaces.

## Extension Entry Point

[[index.ts]] is the main extension module. It registers both tools, initializes the result watcher, async job tracker, slash command bridges, and session lifecycle hooks.

Global mutable state is kept in a single `SubagentState` object defined in [[types.ts]]. Session hooks (`session_start`, `session_shutdown`) reset this state and trigger cleanup.

## Module Map

Core execution:

- [[execution.ts]] — `runSync`: spawns a single pi child process, streams events, returns `SingleResult`
- [[chain-execution.ts]] — `executeChain`: orchestrates sequential + parallel steps, handles chain variables and artifact files
- [[async-execution.ts]] — `executeAsyncSingle`, `executeAsyncChain`: detached background execution via a runner subprocess
- [[subagent-executor.ts]] — `createSubagentExecutor`: routes incoming tool calls to sync/async/management paths; the central dispatch layer

Agent system:

- [[agents.ts]] — `discoverAgents`: discovers agent and chain configs from builtin, user, and project directories
- [[agent-scope.ts]] — scope resolution logic (which agent wins when name collides across scopes)
- [[agent-selection.ts]] — multi-select state merging for the TUI
- [[agent-serializer.ts]] — serialize `AgentConfig` back to markdown frontmatter files
- [[agent-management.ts]] — CRUD handlers for management actions (list, get, create, update, delete)
- [[agent-templates.ts]] — preset templates for new agent/chain creation

Chain system:

- [[settings.ts]] — behavior resolution, chain dir management, template variable expansion
- [[chain-serializer.ts]] — parse/serialize `.chain.md` files
- [[chain-clarify.ts]] — interactive TUI for previewing and editing chain parameters before launch

Skills:

- [[skills.ts]] — skill discovery, resolution with file-mtime caching, injection into system prompts

Execution support:

- [[fork-context.ts]] — `createForkContextResolver`: branched session creation for `context: "fork"` mode
- [[worktree.ts]] — git worktree lifecycle (create, diff, cleanup) for parallel isolation
- [[pi-args.ts]] — `buildPiArgs`, `applyThinkingSuffix`: construct CLI arguments for child pi processes
- [[pi-spawn.ts]] — `getPiSpawnCommand`: cross-platform resolution of the pi executable path
- [[pi-args-tmux.ts]] — `buildPiArgsTmux`: argument builder for tmux TUI/print mode
- [[tmux.ts]] — tmux pane lifecycle: split, wait, idle detection, focus management
- [[tmux-config.ts]] — `TmuxConfig` interface and defaults for tmux pane mode
- [[execution-tmux.ts]] — `runSyncTmux`: tmux TUI execution path (split from `execution.ts`)
- [[execution-runtime-options.ts]] — `ExecutionRuntimeOptions`, `buildRunSyncOptions`: cross-cutting runtime options
- [[chain-run-sync-options.ts]] — `buildChainRunSyncOptions`: runtime options merger for chain call-sites
- [[subagent-config.ts]] — `loadSubagentConfig`, `resolveTmuxConfig`: config loading and tmux resolution
- [[slash-prompt.ts]] — `emitOriginalSlashPrompt`: record slash command prompts in session history
- [[single-output.ts]] — output file handling for solo agent runs

Observability:

- [[artifacts.ts]] — per-run artifact file writing and cleanup (input, output, JSONL, metadata)
- [[async-status.ts]] — enumerate and format async run directories
- [[async-job-tracker.ts]] — track in-flight async jobs, manage polling and widget display
- [[result-watcher.ts]] — file-watch `RESULTS_DIR` for async completion signals
- [[run-history.ts]] — per-agent JSONL run history recording
- [[jsonl-writer.ts]] — async-safe JSONL event stream writer
- [[file-coalescer.ts]] — debounced file write coalescing for high-frequency updates
- [[completion-dedupe.ts]] — deduplication for async completion notifications

UI:

- [[render.ts]] — `renderSubagentResult`, `renderWidget`: TUI component trees for tool results
- [[agent-manager.ts]] — Agents Manager overlay orchestrator (screen routing, CRUD)
- [[agent-manager-list.ts]] — list screen with search, multi-select, scope badges
- [[agent-manager-detail.ts]] — detail screen showing resolved prompt, run history, fields
- [[agent-manager-edit.ts]] — edit screen with model/thinking/skill pickers
- [[agent-manager-parallel.ts]] — parallel builder (slot management)
- [[agent-manager-chain-detail.ts]] — chain detail screen with flow visualization
- [[subagents-status.ts]] — read-only async status overlay
- [[render-helpers.ts]] — shared pad/row/header/footer helpers
- [[text-editor.ts]] — word-navigation text editor with paste support
- [[slash-commands.ts]] — `/run`, `/chain`, `/parallel`, `/agents`, `/subagents-status`
- [[slash-bridge.ts]] — bridge between slash command events and executor
- [[slash-live-state.ts]] — live snapshot management for in-progress slash results
- [[prompt-template-bridge.ts]] — delegation bridge for pi-prompt-template-model integration

Schemas and types:

- [[schemas.ts]] — TypeBox parameter schemas for `subagent` and `subagent_status` tools
- [[types.ts]] — all shared types, constants, `truncateOutput`, recursion guard

## State Management

All per-session mutable state lives in a single `SubagentState` object (defined in [[types.ts#SubagentState]]) owned by the extension and passed to collaborating modules.

It holds: `baseCwd`, `currentSessionId`, `asyncJobs` map, `cleanupTimers`, `lastUiContext`, async file watcher, poller handle, completion deduplication map, and the result file coalescer. State is reset on `session_start` events.

## Process Model

Each subagent is a child pi process spawned via `node:child_process`. In sync mode, stdout/stderr are parsed as JSONL events in real time.

In async mode, execution is handed off to `subagent-runner.ts` as a detached process. It writes status to `<tmpdir>/pi-async-subagent-runs/<id>/status.json` and events to `events.jsonl`. See [[execution#Process Spawning]].

## Dependency Graph

`subagent-executor.ts` depends on nearly all other modules. `types.ts` and `utils.ts` are leaves with no internal imports.

`settings.ts` owns chain-step behavior resolution and is imported by both `chain-execution.ts` and `async-execution.ts`. `agents.ts` is imported by all execution paths and the management layer.
