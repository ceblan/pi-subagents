/**
 * buildChainRunSyncOptions — helper for chain execution call-sites.
 *
 * Encapsulates runtime options (e.g. tmuxConfig) so that chain-execution.ts
 * only needs to spread this helper at each runSync call-site rather than
 * propagating individual fields through ChainExecutionParams and
 * ParallelChainRunInput.
 */

import type { ExecutionRuntimeOptions } from "./execution-runtime-options.js";
import type { RunSyncOptions } from "./types.js";

/**
 * Merge base RunSyncOptions with ExecutionRuntimeOptions for chain steps.
 * Prefer this over manually threading runtime fields through chain interfaces.
 */
// @lat: [[execution#Tmux TUI Mode#Runtime Options Propagation]]
export function buildChainRunSyncOptions(
	base: Omit<RunSyncOptions, "tmuxConfig">,
	runtime: ExecutionRuntimeOptions,
): RunSyncOptions {
	return { ...base, tmuxConfig: runtime.tmuxConfig };
}
