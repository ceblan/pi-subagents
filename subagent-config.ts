/**
 * Subagent extension configuration helpers.
 *
 * Extracted from index.ts so that config loading and tmux resolution
 * stay isolated from the plugin wiring code.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TmuxConfig, DEFAULT_TMUX_CONFIG } from "./tmux-config.js";
import type { ExtensionConfig } from "./types.js";

/**
 * Load subagent extension config from the user config file.
 * Returns an empty object if the file is missing or invalid.
 */
export function loadSubagentConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}

/**
 * Resolve the effective TmuxConfig by merging DEFAULT_TMUX_CONFIG with
 * any overrides from the extension config.
 */
// @lat: [[execution#Tmux TUI Mode#Configuration]]
export function resolveTmuxConfig(config: ExtensionConfig): TmuxConfig {
	return { ...DEFAULT_TMUX_CONFIG, ...(config.tmux ?? {}) };
}
