# Chain System

Chains are sequential pipelines that pass output between steps via template variables, support nested parallel fan-out, shared artifact directories, and optional interactive TUI clarification.

## Chain Execution

`executeChain` in [[chain-execution.ts]] runs steps in order. Before execution the clarify TUI may be shown (default: true for chains).

Each sequential step receives template-resolved task text. A `{ parallel: [...] }` step fans out to multiple concurrent agents and aggregates their output. The aggregated text becomes `{previous}` for the next step.

## Chain Variables

Three template variables are substituted per step by `resolveChainTemplates` in [[settings.ts]]:

| Variable | Value |
|----------|-------|
| `{task}` | The original task from the first step |
| `{previous}` | Output text from the immediately preceding step (or aggregated parallel outputs) |
| `{chain_dir}` | Absolute path to the shared chain artifact directory |

## Chain Directory

Each chain run gets a directory at `<tmpdir>/pi-chain-runs/<runId>/` created by `createChainDir` in [[settings.ts]].

Agents write files here (`context.md`, `plan.md`, `progress.md`, etc.) and subsequent steps can read them via `reads:`. Parallel step outputs go to `parallel-<stepIndex>/<N>-<agent>/output.md`. Directories older than 24 hours are cleaned up at extension startup.

## Step Behavior Resolution

Each step's `output`, `reads`, `progress`, `skills`, and `model` are resolved by `resolveStepBehavior` in [[settings.ts]].

Three-state semantics: tool param override → agent frontmatter default → no-op. Setting a field to `false` explicitly disables it, overriding the agent's default.

## Chain Files

Reusable chains are stored as `.chain.md` files alongside agent files, parsed and serialized by [[chain-serializer.ts]].

The format uses `## agent-name` section headers; config lines go immediately after the header, separated from task text by a blank line. Chain files can be saved from the clarify TUI using the `W` keybinding.

## Parallel Steps

A chain step may be `{ parallel: [...] }` instead of a sequential step. `resolveParallelBehaviors` in [[settings.ts]] assigns output directories under `parallel-<stepIndex>/`.

Concurrency is bounded by `concurrency` (default 4). `failFast: true` aborts remaining tasks on first failure. Results are concatenated by `aggregateParallelOutputs` with `=== Parallel Task N (agent) ===` separators.

## Clarify TUI

`ChainClarifyComponent` in [[chain-clarify.ts]] previews chain steps before execution.

Keys: `e` edit task, `m` model, `t` thinking, `s` skills, `b` toggle async, `w` output file, `r` reads list, `p` progress, `S` save to agent file, `W` save to `.chain.md`. Press `Enter` to run, `Esc` to cancel.

## Async Chain Execution

When `clarify: false, async: true`, the chain is handed to `executeAsyncChain` in [[async-execution.ts]].

It serializes the steps and launches `subagent-runner.ts` as a detached subprocess. The runner orchestrates steps sequentially and writes progress to `status.json`. See [[async-observability]].
