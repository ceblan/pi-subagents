# Overview

`pi-subagents` is a pi coding-agent extension that delegates tasks to specialized AI subagents with single-agent runs, sequential chains, and parallel execution — all with optional async operation and a full Agents Manager TUI.

## Purpose

The extension lets the LLM spawn child agent processes for complex multi-step work. Tasks are broken into specialized roles — scout, planner, worker, reviewer — each running as an independent pi process.

Instead of a single agent handling everything in one session, specialized agents collaborate through text output passed between steps via chain variables.

## Installation and Registration

Two tools are registered: `subagent` and `subagent_status`. Slash commands (`/run`, `/chain`, `/parallel`, `/agents`, `/subagents-status`) and an Agents Manager overlay are also registered. See [[architecture#Extension Entry Point]].

The extension is installed via `pi install npm:pi-subagents` and declared as a pi package via `"pi": { "extensions": ["./index.ts", "./notify.ts"] }` in `package.json`.

## Pi Package

The main extension (`index.ts`) handles execution and UI. The notify extension (`notify.ts`) handles async completion notifications as a separate process-scoped listener. Both are declared in `package.json → pi.extensions`.

## Execution Modes

Three primary modes: **single** (one agent + task), **chain** (sequential pipeline with `{previous}` passing), and **parallel** (concurrent agents). All modes support foreground and background (async) execution. See [[execution#Execution Modes]].

## Key Design Principles

Every subagent runs as a completely separate `pi` child process with full isolation. The parent communicates with children only through output text, artifact files, and JSONL events.

This process-per-agent model means children can use any tools, session state, or models independently, and failures are contained to individual steps without crashing the parent session.
