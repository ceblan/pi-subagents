# Execution

All execution paths produce a `SingleResult` (from [[types.ts]]) per agent run. The executor routes to sync or async depending on the `async` parameter and the clarify TUI outcome.

## Execution Modes

Three modes dispatched from [[subagent-executor.ts#createSubagentExecutor]]:

- **Single**: `{ agent, task }` — one agent, one task. Optional `output` file, `model` override, `skill` override.
- **Parallel**: `{ tasks: [...] }` — multiple agents run concurrently up to `MAX_PARALLEL` (8) and `MAX_CONCURRENCY` (4). Each task may have a `count` to repeat N times.
- **Chain**: `{ chain: [...] }` — sequential pipeline. Steps can include nested `{ parallel: [...] }` fan-out steps. See [[chain#Chain Execution]].

## Process Spawning

`runSync` in [[execution.ts]] resolves the target agent once, then each attempt (headless or tmux) reuses that same `AgentConfig` while spawning a child pi process via [[pi-spawn.ts#getPiSpawnCommand]].

Arguments are built by [[pi-args.ts#buildPiArgs]] which translates agent config and runtime overrides into pi CLI flags: `--model`, `--system-prompt`, `--tools`, `--skill`, `--session`, `--no-extensions`, `--extension`, and others. Skill content is injected into the system prompt string before spawning — not as a separate CLI flag.

## Sync vs Async

**Foreground (sync)**: The tool call blocks, streams progress via `onUpdate`, and returns a full result.

**Background (async)**: Launches a detached subprocess (`subagent-runner.ts`) and returns immediately with an `asyncId`. The runner writes `status.json` and `events.jsonl` to `ASYNC_DIR/<id>/`. Completion is signaled by a result file dropped in `RESULTS_DIR`. See [[async-observability#Async Run Files]].

Background requires `clarify: false` for chains. Parallel `async: true` is converted to a chain internally.

## Fork Context

`context: "fresh"` (default) starts each child from a clean session. `context: "fork"` creates a branched session from the parent's current leaf, implemented in [[fork-context.ts#createForkContextResolver]].

Forked sessions use `--session <branched-file>` and prepend a preamble to the task. Fork fails fast if the parent session is not persisted or the current leaf is missing — it never silently downgrades to `fresh`.

## Recursion Guard

Nested subagent calls are depth-limited via the `PI_SUBAGENT_DEPTH` environment variable, incremented on each spawn.

The limit defaults to 2 (main → subagent → sub-subagent). Checked in [[types.ts#checkSubagentDepth]] before any execution. Override with `PI_SUBAGENT_MAX_DEPTH` (must be set before starting pi).

## Output Truncation

Raw output is truncated to configurable `maxOutput` limits (default 200 KB, 5000 lines).

`truncateOutput` in [[types.ts]] writes the full output to an artifact file and embeds the artifact path in the truncation notice. See [[artifacts#Artifact Files]].

## Skill Injection

Skills from agent frontmatter or the `skill` runtime override are resolved by [[skills.ts]] and injected into the system prompt as `<skill name="...">...</skill>` XML blocks.

Missing skills produce a warning in the result summary but do not abort execution. See [[skills#Skill Resolution]].

## Tmux TUI Mode

When `tmuxConfig.enabled` is true and the process runs inside tmux, subagents launch in a visible tmux pane instead of headless JSON streaming.

`isTmux()` in [[tmux.ts]] checks the `TMUX` environment variable. If tmux is detected, [[execution-tmux.ts#runSyncTmux]] takes over: it builds TUI-mode arguments via [[pi-args-tmux.ts#buildPiArgsTmux]], opens a split pane with [[tmux.ts#runInTmuxPane]], waits for the pane to exit (or go idle), then parses the session JSONL to build a `SingleResult`.

### Configuration

`TmuxConfig` is defined in [[tmux-config.ts]] with defaults (`enabled: false`, `split: "vertical"`, `closeOnComplete: true`, `interactive: true`). User overrides come from the `tmux` key in the extension `config.json`, resolved by [[subagent-config.ts#resolveTmuxConfig]].

### Runtime Options Propagation

`ExecutionRuntimeOptions` in [[execution-runtime-options.ts]] wraps cross-cutting options like `tmuxConfig` into a single object. Helper functions `buildRunSyncOptions` and [[chain-run-sync-options.ts#buildChainRunSyncOptions]] merge these into `RunSyncOptions` at every `runSync` call-site across single, parallel, and chain paths.

### Interactive vs Print Mode

`buildPiArgsTmux` supports two modes: `interactive=true` launches full TUI (no `--mode`, no `-p`) so the user can interact; `interactive=false` uses `-p` (print mode) where the agent runs visibly but exits automatically.

### Idle Detection

When `idleTimeoutMs > 0`, [[tmux.ts#waitForPaneExitOrIdle]] monitors the session JSONL file's mtime. If the file is unchanged for the timeout period and the last message is `role=assistant` without tool calls (checked by [[tmux.ts#isAgentIdleInSessionFile]]), the agent is considered idle and the pane is closed.

## Model Override and Fallback

Runtime `model` overrides are processed by `applyThinkingSuffix` in [[pi-args.ts]] which merges any thinking-level suffix. The agent's `thinking` field is only applied if the model has no existing suffix.

`runSync` builds candidate models using [[model-fallback.ts#buildModelCandidates]] from `modelOverride ?? agent.model` plus `agent.fallbackModels`, and records attempt metadata (`attemptedModels`, `modelAttempts`) in `SingleResult`.

Retries only happen for retryable provider/model failures matched by [[model-fallback.ts#isRetryableModelFailure]]; ordinary task/tool failures do not trigger model failover.

## Intercom Bridge Detach

When intercom bridge orchestration is active, a running single-agent attempt can detach instead of being hard-killed if an intercom handoff is requested mid-run.

`execution.ts` listens for `pi-intercom:detach-request` / `pi-intercom:detach-response` events (from [[types.ts]]) and marks results as `detached` with `detachedReason="intercom coordination"` when accepted.

## Worktree Isolation

When `worktree: true` is set, `createWorktrees` in [[worktree.ts]] creates one temporary git worktree per agent, each branched from HEAD.

After completion, `diffWorktrees` captures `git diff --cached` stats and writes `.patch` files to the artifacts directory. Worktrees are cleaned up in a `finally` block. See [[worktree-isolation]].
