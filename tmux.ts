/**
 * tmux helper — split panes, wait for exit, focus management.
 *
 * Reuses patterns from split-fork.ts (shellQuote, getPiInvocationParts)
 * but adapted for subagent execution where we need to wait for completion
 * and parse results from session files.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { TmuxConfig } from "./tmux-config.js";



// ============================================================================
// Shell quoting (from split-fork.ts)
// ============================================================================

export function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ============================================================================
// pi invocation resolution (from split-fork.ts)
// ============================================================================

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ["pi"];
}

/**
 * Build the base `pi` command string (quoted for shell).
 * Returns e.g. `'/path/to/node' '/path/to/pi.mjs'` or just `'pi'`.
 */
export function getPiCommandBase(): string {
	return getPiInvocationParts().map(shellQuote).join(" ");
}

// ============================================================================
// tmux detection & pane management
// ============================================================================

/** Returns true when running inside a tmux session */
export function isTmux(): boolean {
	return Boolean(process.env.TMUX);
}

/** Get the current tmux pane id (e.g. %3) */
export function getCurrentPane(): string {
	return execSync("tmux display-message -p '#{pane_id}'", {
		encoding: "utf-8",
	}).trim();
}

/** Move focus to a specific pane */
export function focusPane(paneId: string): void {
	try {
		execSync(`tmux select-pane -t ${paneId}`, { stdio: "ignore" });
	} catch {
		// Pane may have been closed
	}
}

/** Kill a pane */
export function killPane(paneId: string): void {
	try {
		execSync(`tmux kill-pane -t ${paneId}`, { stdio: "ignore" });
	} catch {
		// Pane may have been closed manually
	}
}

/** Check if a pane still exists */
function paneExists(paneId: string): boolean {
	try {
		const panes = execSync("tmux list-panes -a -F '#{pane_id}'", {
			encoding: "utf-8",
		});
		return panes.includes(paneId);
	} catch {
		return false;
	}
}

// ============================================================================
// Core: split & wait
// ============================================================================

export interface TmuxPaneResult {
	paneId: string;
	/** Whether the pane exited normally (true) or was killed/missing (false) */
	completed: boolean;
	/** Whether the pane was closed due to idle detection */
	idleDetected?: boolean;
}

/**
 * Open a new tmux pane running `command` and return its pane id.
 *
 * The pane runs the command directly — when the command exits the pane
 * closes (shell replaced by exec, or shell exits after command).
 */
export function openPane(command: string, cwd: string, config: TmuxConfig): string {
	const splitFlag = config.split === "vertical" ? "-h" : "-v";
	// -d = don't focus the new pane (unless focusSubagent is true)
	const dontFocus = config.focusSubagent ? "" : " -d";
	const tmuxCmd =
		`tmux split-window ${splitFlag}${dontFocus} -c ${shellQuote(cwd)} -P -F '#{pane_id}' ${shellQuote(command)}`;
	return execSync(tmuxCmd, { encoding: "utf-8" }).trim();
}

/**
 * Wait until a tmux pane no longer exists (its process exited).
 *
 * Uses polling — tmux doesn't expose a blocking wait-for-pane-exit.
 * 500ms poll is plenty: we only need this to know *when* to read
 * the session file, not to stream real-time events.
 */
export function waitForPaneExit(paneId: string, pollMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const check = () => {
			if (!paneExists(paneId)) {
				resolve(true);
				return;
			}
			setTimeout(check, pollMs);
		};
		// First check immediately
		check();
	});
}

// ============================================================================
// High-level: run pi in a tmux pane and wait
// ============================================================================

/**
 * Build the full shell command to run pi in a tmux pane.
 *
 * Wraps the command so that:
 * 1. Environment variables are set
 * 2. Working directory is handled via tmux -c
 * 3. The pane closes when pi exits (if closeOnComplete)
 * 4. If !closeOnComplete, a "press enter" prompt keeps the pane open
 */
export function buildTmuxShellCommand(
	piArgs: string[],
	env: Record<string, string | undefined>,
	closeOnComplete: boolean,
): string {
	const piBase = getPiCommandBase();
	const quotedArgs = piArgs.map(shellQuote).join(" ");
	const envPairs = Object.entries(env)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}=${shellQuote(v!)}`)
		.join(" ");

	const piCommand = envPairs
		? `${envPairs} ${piBase} ${quotedArgs}`
		: `${piBase} ${quotedArgs}`;

	if (closeOnComplete) {
		return piCommand;
	}
	// Keep pane open after exit so the user can review
	return `${piCommand}; echo ''; echo '[subagent finished — press Enter to close]'; read`;
}

// ============================================================================
// Session JSONL idle detection
// ============================================================================

/**
 * Find the latest .jsonl session file in a directory.
 */
function findSessionFile(sessionDir: string): string | null {
	try {
		const files = readdirSync(sessionDir)
			.filter(f => f.endsWith(".jsonl"))
			.map(f => ({
				path: path.join(sessionDir, f),
				mtime: statSync(path.join(sessionDir, f)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);
		return files[0]?.path ?? null;
	} catch {
		return null;
	}
}

/**
 * Check if the agent is semantically idle by inspecting the last message
 * entry in the session JSONL file.
 *
 * Returns true when the last message is `role=assistant` with no tool calls
 * in its content — meaning the agent finished its turn and is waiting for
 * user input.
 */
// @lat: [[execution#Tmux TUI Mode#Idle Detection]]
export function isAgentIdleInSessionFile(sessionFilePath: string): boolean {
	try {
		const content = readFileSync(sessionFilePath, "utf-8");
		const lines = content.split("\n").filter(l => l.trim());

		// Walk backwards to find the last "message" entry
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const entry = JSON.parse(lines[i]!);
				if (entry.type !== "message") continue;

				const msg = entry.message;
				if (!msg) continue;

				if (msg.role === "user" || msg.role === "toolResult") return false;

				if (msg.role === "assistant") {
					const parts = Array.isArray(msg.content) ? msg.content : [];
					const hasToolCall = parts.some(
						(c: { type?: string }) =>
							c.type === "toolCall" || c.type === "tool_use" || c.type === "toolUse",
					);
					return !hasToolCall;
				}

				return false;
			} catch {
				continue; // malformed line, skip
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Wait until a tmux pane exits OR the subagent goes idle.
 *
 * Idle is detected by monitoring the session JSONL file:
 * 1. mtime hasn't changed for `idleTimeoutMs` milliseconds
 * 2. The last message entry is `role=assistant` without tool calls
 *
 * This is immune to TUI rendering noise — pi only writes to the session
 * file on semantic events (message_end), not on screen refreshes.
 */
// @lat: [[execution#Tmux TUI Mode#Idle Detection]]
export function waitForPaneExitOrIdle(
	paneId: string,
	sessionDir: string,
	config: TmuxConfig,
): Promise<TmuxPaneResult> {
	const pollMs = config.idlePollMs ?? 500;
	const idleTimeoutMs = config.idleTimeoutMs ?? 0;

	return new Promise((resolve) => {
		let sessionFile: string | null = null;
		let lastMtime = 0;
		let idleSince: number | null = null;

		const check = () => {
			// 1. Pane closed — normal exit
			if (!paneExists(paneId)) {
				resolve({ paneId, completed: true, idleDetected: false });
				return;
			}

			// 2. Idle detection (only when enabled)
			if (idleTimeoutMs > 0) {
				if (!sessionFile) {
					sessionFile = findSessionFile(sessionDir);
				}

				if (sessionFile) {
					try {
						const currentMtime = statSync(sessionFile).mtimeMs;

						if (currentMtime !== lastMtime) {
							lastMtime = currentMtime;
							idleSince = null;
						} else {
							if (idleSince === null) {
								idleSince = Date.now();
							} else if (Date.now() - idleSince >= idleTimeoutMs) {
								if (isAgentIdleInSessionFile(sessionFile)) {
									resolve({ paneId, completed: false, idleDetected: true });
									return;
								}
								// Semantic check failed (LLM thinking, tool in flight) — reset
								idleSince = null;
							}
						}
					} catch {
						// Session file may be in the process of being written
					}
				}
			}

			setTimeout(check, pollMs);
		};

		check();
	});
}

// ============================================================================
// High-level: run pi in a tmux pane and wait
// ============================================================================

/**
 * Run a pi subagent in a new tmux pane and wait for it to complete.
 *
 * Returns when the pane's process exits. If `sessionDir` is provided and
 * `config.idleTimeoutMs > 0`, also returns when the subagent is detected
 * as idle (session JSONL inactive + last message is assistant without tool calls).
 *
 * The caller should then parse the session file to extract results.
 */
// @lat: [[execution#Tmux TUI Mode]]
export async function runInTmuxPane(
	piArgs: string[],
	env: Record<string, string | undefined>,
	cwd: string,
	config: TmuxConfig,
	sessionDir?: string,
): Promise<TmuxPaneResult> {
	const origPane = getCurrentPane();
	const command = buildTmuxShellCommand(piArgs, env, config.closeOnComplete);
	const paneId = openPane(command, cwd, config);

	let result: TmuxPaneResult;

	if (sessionDir && config.idleTimeoutMs && config.idleTimeoutMs > 0) {
		result = await waitForPaneExitOrIdle(paneId, sessionDir, config);

		if (result.idleDetected && config.closeOnComplete) {
			killPane(paneId);
		}
	} else {
		const completed = await waitForPaneExit(paneId);
		result = { paneId, completed };
	}

	// Return focus to original pane if we moved it
	if (config.focusSubagent) {
		focusPane(origPane);
	}

	return result;
}
