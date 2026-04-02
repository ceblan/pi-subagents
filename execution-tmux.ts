/**
 * Tmux TUI execution mode for subagents.
 *
 * Extracted from execution.ts so that tmux-specific code evolves separately
 * from the stable headless (JSON-streaming) path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import {
	type ResolvedSkill,
	type RunSyncOptions,
	type SingleResult,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.js";
import type { TmuxConfig } from "./tmux-config.js";
import { buildPiArgsTmux } from "./pi-args-tmux.js";
import { cleanupTempDir } from "./pi-args.js";
import { isTmux, runInTmuxPane } from "./tmux.js";
import { parseSessionDir } from "./session-parser.js";

export { isTmux };

export interface TmuxResolvedContext {
	effectiveModel: string | undefined;
	skillNames: string[];
	resolvedSkills: ResolvedSkill[];
	missingSkills: string[];
	systemPrompt: string;
	tmuxConfig: TmuxConfig;
}

/**
 * Run a subagent in a tmux pane with full TUI.
 *
 * Instead of `--mode json -p`, we launch `pi` without those flags,
 * which enters InteractiveMode. The user sees and can interact with
 * the subagent. Results are recovered from the session.jsonl file
 * after the pane exits.
 */
// @lat: [[execution#Tmux TUI Mode]]
export async function runSyncTmux(
	runtimeCwd: string,
	agent: AgentConfig,
	agentName: string,
	task: string,
	options: RunSyncOptions,
	resolved: TmuxResolvedContext,
): Promise<SingleResult> {
	const startTime = Date.now();
	const { cwd, maxOutput } = options;
	const effectiveCwd = cwd ?? runtimeCwd;

	// Ensure a session directory exists — we need it to recover results
	const sessionDir = options.sessionDir
		?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-tmux-"));
	fs.mkdirSync(sessionDir, { recursive: true });

	// Build args for tmux mode
	const { args, env: sharedEnv, tempDir } = buildPiArgsTmux({
		task,
		sessionEnabled: true,
		sessionDir,
		sessionFile: options.sessionFile,
		model: resolved.effectiveModel,
		thinking: agent.thinking,
		tools: agent.tools,
		extensions: agent.extensions,
		skills: resolved.skillNames,
		systemPrompt: resolved.systemPrompt || undefined,
		mcpDirectTools: agent.mcpDirectTools,
		promptFileStem: agent.name,
	}, resolved.tmuxConfig.interactive);

	const spawnEnv: Record<string, string | undefined> = {
		...sharedEnv,
		...getSubagentDepthEnv(),
	};

	// Run pi in a tmux pane and wait for it to finish (or go idle)
	await runInTmuxPane(args, spawnEnv, effectiveCwd, resolved.tmuxConfig, sessionDir);

	// Parse the session file to extract results
	const sessionResult = parseSessionDir(sessionDir);

	cleanupTempDir(tempDir);

	const durationMs = Date.now() - startTime;

	// Build a SingleResult compatible with the existing pipeline
	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: sessionResult.exitCode,
		messages: sessionResult.messages,
		usage: sessionResult.usage,
		error: sessionResult.error,
		sessionFile: sessionResult.sessionFile,
		skills: resolved.resolvedSkills.length > 0 ? resolved.resolvedSkills.map((s) => s.name) : undefined,
		skillsWarning: resolved.missingSkills.length > 0 ? `Skills not found: ${resolved.missingSkills.join(", ")}` : undefined,
		progressSummary: {
			toolCount: 0, // Not available in TUI mode
			tokens: sessionResult.usage.input + sessionResult.usage.output,
			durationMs,
		},
	};

	// Handle truncation
	if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const truncationResult = truncateOutput(sessionResult.finalOutput, config);
		if (truncationResult.truncated) {
			result.truncation = truncationResult;
		}
	}

	return result;
}
