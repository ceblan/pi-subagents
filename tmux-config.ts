/**
 * Tmux-specific config extracted from types.ts to reduce merge pressure on
 * the shared hotspot file.
 */

export interface TmuxConfig {
	/** Enable tmux pane spawning for subagents */
	enabled: boolean;
	/** Split direction: "vertical" = side-by-side, "horizontal" = stacked */
	split: "vertical" | "horizontal";
	/** Close the pane automatically when the subagent finishes */
	closeOnComplete: boolean;
	/** Move focus to the subagent pane */
	focusSubagent: boolean;
	/** Full TUI mode (interactive). If false, uses print mode (visible but auto-exits) */
	interactive: boolean;
	/** ms of session JSONL inactivity before declaring idle (0 = disabled). Only applies when interactive=true. */
	idleTimeoutMs?: number;
	/** Polling interval in ms for session file mtime checks (default: 500) */
	idlePollMs?: number;
}

export const DEFAULT_TMUX_CONFIG: TmuxConfig = {
	enabled: false,
	split: "vertical",
	closeOnComplete: true,
	focusSubagent: false,
	interactive: true,
	idleTimeoutMs: 0,
	idlePollMs: 500,
};
