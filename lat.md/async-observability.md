# Async Observability

Background (async) runs write durable state files so they can be inspected after the originating session has moved on or closed.

## Async Run Files

Each async run creates a directory at `<tmpdir>/pi-async-subagent-runs/<id>/` containing three files:

- `status.json` — source of truth for run state, step progress, timing, and token usage. Written atomically via temp-file rename.
- `events.jsonl` — append-only log of structured events as they occur.
- `subagent-log-<id>.md` — human-readable markdown log.

Completion signals are dropped in `<tmpdir>/pi-async-subagent-results/`. The result watcher in [[result-watcher.ts]] monitors that directory and triggers UI updates.

## AsyncStatus Type

The `AsyncStatus` interface in [[types.ts]] captures the full run state.

Fields: `runId`, `mode`, `state`, `startedAt`, `endedAt`, `lastUpdate`, `cwd`, `currentStep`, `steps[]`, `sessionDir`, `outputFile`, `totalTokens`, and `sessionFile`. The `steps` array tracks per-step agent name, status, duration, and token usage.

## Status Tool

The `subagent_status` tool (registered in [[index.ts]]) inspects async runs.

It accepts `{ action: "list" }` for active runs, or `{ id }` / `{ dir }` for one specific run. It reads `status.json` via `readStatus` in [[utils.ts]] and formats results as plain text. Prefix matching on `id` is supported via `findByPrefix`.

## Status Overlay

The `/subagents-status` slash command opens a read-only TUI overlay rendered by [[subagents-status.ts]].

It auto-refreshes every 2 seconds, lists active runs followed by recent completed/failed runs. Select with `↑↓`, close with `Esc`.

## Async Widget

During a session with active background jobs, a small widget is displayed in the TUI sidebar via `renderWidget` in [[render.ts]].

It shows up to `MAX_WIDGET_JOBS` (4) concurrent jobs with their current step and state. Updated via a polling interval (`POLL_INTERVAL_MS = 250 ms`) managed by [[async-job-tracker.ts]].

## Event Bus

Two extension-level events coordinate async lifecycle:

- `subagent:started` — emitted when an async run begins; captured by [[async-job-tracker.ts]]
- `subagent:complete` — emitted when a run finishes; consumed by [[notify.ts]] for session-scoped notifications and by [[async-job-tracker.ts]] for widget updates

Completion deduplication (so a single run fires one notification) is handled by [[completion-dedupe.ts]].

## Run History

Synchronous run outcomes are recorded to a per-agent JSONL file by `recordRun` in [[run-history.ts]]. Each entry captures `task`, `exitCode`, `durationMs`, `tokens`, `model`, and `skills`. The Agents Manager Detail screen reads this history to show recent runs.
