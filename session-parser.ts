/**
 * Session file parser — extract results from pi session.jsonl files.
 *
 * When subagents run in TUI mode (tmux panes) there is no JSON streaming
 * to parse. Instead, results are recovered by reading the session file
 * that pi writes automatically.
 */

import * as fs from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import { findLatestSessionFile } from "./utils.js";

export interface SessionParseResult {
	messages: Message[];
	finalOutput: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	exitCode: 0 | 1;
	error?: string;
	sessionFile?: string;
}

/**
 * Parse a pi session.jsonl file and extract messages, usage, and final output.
 *
 * Session files contain newline-delimited JSON entries with these types:
 *   - { type: "session", ... }         — header
 *   - { type: "message", message: {} } — user/assistant/tool messages
 *   - { type: "model_change", ... }    — model switches
 *
 * We only care about "message" entries.
 */
export function parseSessionFile(sessionFilePath: string): SessionParseResult {
	const empty: SessionParseResult = {
		messages: [],
		finalOutput: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		exitCode: 1,
		error: "Empty or unreadable session file",
		sessionFile: sessionFilePath,
	};

	let content: string;
	try {
		content = fs.readFileSync(sessionFilePath, "utf-8");
	} catch {
		return { ...empty, error: `Cannot read session file: ${sessionFilePath}` };
	}

	const messages: Message[] = [];
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let turns = 0;

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) {
				const msg = entry.message as Message;
				messages.push(msg);

				if (msg.role === "assistant") {
					turns++;
					const u = (msg as Record<string, unknown>).usage as
						| { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
						| undefined;
					if (u) {
						totalInput += u.input ?? 0;
						totalOutput += u.output ?? 0;
						totalCacheRead += u.cacheRead ?? 0;
						totalCacheWrite += u.cacheWrite ?? 0;
						totalCost += u.cost?.total ?? 0;
					}
				}
			}
		} catch {
			// Skip malformed lines — session may be partially written
		}
	}

	// Extract final assistant text
	let finalOutput = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text" && "text" in part) {
					finalOutput = (part as { text: string }).text;
					break;
				}
			}
			if (finalOutput) break;
		}
	}

	const hasOutput = finalOutput.length > 0 || messages.length > 0;

	return {
		messages,
		finalOutput,
		usage: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			cost: totalCost,
			turns,
		},
		exitCode: hasOutput ? 0 : 1,
		error: hasOutput ? undefined : "No assistant output found in session",
		sessionFile: sessionFilePath,
	};
}

/**
 * Find the latest session file in a directory and parse it.
 *
 * Convenience wrapper for the common pattern:
 *   1. Find *.jsonl in sessionDir sorted by mtime
 *   2. Parse the newest one
 */
export function parseSessionDir(sessionDir: string): SessionParseResult {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) {
		return {
			messages: [],
			finalOutput: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			exitCode: 1,
			error: `No session file found in ${sessionDir}`,
		};
	}
	return parseSessionFile(sessionFile);
}
