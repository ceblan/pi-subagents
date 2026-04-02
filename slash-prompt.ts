/**
 * Slash prompt emission helper.
 *
 * Extracted from slash-commands.ts so that the originalPrompt recording
 * stays isolated from handler parsing/flag logic.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SLASH_RESULT_TYPE } from "./types.js";

/**
 * Record the original slash prompt as a user message so it appears in
 * the session history and can be used as a fork point.
 */
export function emitOriginalSlashPrompt(
	pi: ExtensionAPI,
	originalPrompt: string | undefined,
): void {
	if (!originalPrompt) return;
	pi.sendMessage({
		customType: SLASH_RESULT_TYPE,
		content: originalPrompt,
		display: true,
		details: { type: "slash-prompt" },
	});
}
