/**
 * ExecutionRuntimeOptions — shared runtime context for all execution paths.
 *
 * Encapsulates cross-cutting options (e.g. tmuxConfig) that were previously
 * propagated field-by-field through ExecutorDeps, ForegroundParallelRunInput,
 * ChainExecutionParams, etc.  Using a single object reduces merge surface
 * when new runtime options are added.
 */

import type { TmuxConfig } from "./tmux-config.js";
import type { RunSyncOptions } from "./types.js";

export interface ExecutionRuntimeOptions {
	/** tmux pane configuration (if enabled, run in tmux TUI mode) */
	tmuxConfig?: TmuxConfig;
}

/**
 * Merges base RunSyncOptions with ExecutionRuntimeOptions.
 *
 * Use this at every runSync call-site to avoid propagating individual
 * runtime fields manually.
 */
// @lat: [[execution#Tmux TUI Mode#Runtime Options Propagation]]
export function buildRunSyncOptions(
	base: Omit<RunSyncOptions, "tmuxConfig">,
	runtime: ExecutionRuntimeOptions,
): RunSyncOptions {
	return { ...base, tmuxConfig: runtime.tmuxConfig };
}
