/**
 * Pi argument builder for tmux TUI mode.
 *
 * Extracted from pi-args.ts to keep the base module agnostic of execution mode.
 */

import { buildPiArgs, type BuildPiArgsInput, type BuildPiArgsResult } from "./pi-args.js";

/**
 * Build pi args for tmux-visible mode.
 *
 * - interactive=false (default): uses `-p` (print mode, text output).
 *   The agent works, output is visible in the tmux pane, and pi exits
 *   automatically when the task is complete. Not interactive.
 *
 * - interactive=true: no `-p`, no `--mode`. Enters full TUI mode.
 *   The user can interact with the subagent. Pi stays open until
 *   the user manually exits (Ctrl+C, /exit, etc.).
 */
// @lat: [[execution#Tmux TUI Mode#Interactive vs Print Mode]]
export function buildPiArgsTmux(
	input: Omit<BuildPiArgsInput, "baseArgs">,
	interactive = false,
): BuildPiArgsResult {
	const baseArgs = interactive ? [] : ["-p"];
	return buildPiArgs({ ...input, baseArgs });
}
