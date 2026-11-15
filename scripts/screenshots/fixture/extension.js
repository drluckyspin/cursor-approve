// -----------------------------------------------------------------------------------------------------------
// Screenshot fixture for `make screenshots`
//
// Loaded only into the throwaway, signed-out Cursor instance that scripts/screenshots/capture.mjs launches,
// alongside Cursor Approve. No agent can run there, so this registers stand-ins for Cursor's composer
// commands, which the extension host prefers over Cursor's own, and it plays the part of an agent asking for
// approval by writing the two ComposerWakelockManager lines Cursor writes to the window's renderer log. Cursor
// Approve then counts those approvals through its real code path, so the dashboard in the README shows what
// the extension actually computed.
//
// The capture script drives it through two files in CURSOR_APPROVE_FIXTURE_DIR: it writes control.json with
// the number of requests to make, and this writes status.json as each one is answered.
// -----------------------------------------------------------------------------------------------------------
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

/** Cursor 3.27.22 resumed an agent 7 to 10ms after the approval call that released it returned. */
const RESUME_DELAY_MS = 8;

/**
 * Pause between one approval and the agent's next request. Shorter than the poll interval, so each request is
 * logged before the poll that answers it, which is the order Cursor Approve requires before it credits one.
 */
const NEXT_REQUEST_DELAY_MS = 300;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	// Only the capture script sets this, on the instance it launches. Anywhere else, answering Cursor's approval
	// commands here would fake approvals and shadow the real ones.
	const fixtureDir = process.env.CURSOR_APPROVE_FIXTURE_DIR;
	if (!fixtureDir) {
		return;
	}

	// Cursor Approve looks for the renderer log two levels above its own log folder; so does this.
	const rendererLog = path.join(context.logUri.fsPath, "..", "..", "renderer.log");

	let wakelockId = 1000;
	let issued = 0;
	let resolved = 0;

	/** @type {string | undefined} Chat waiting for approval. */
	let pending;
	let requestScheduled = false;

	/** Requests the capture script has asked for, or none before it writes control.json. */
	function requestedCount() {
		try {
			const control = JSON.parse(fs.readFileSync(path.join(fixtureDir, "control.json"), "utf8"));
			return typeof control.requests === "number" ? control.requests : 0;
		} catch {
			return 0;
		}
	}

	function writeStatus() {
		fs.writeFileSync(path.join(fixtureDir, "status.json"), JSON.stringify({ issued, resolved }));
	}

	/** Append one line in the format Cursor's ComposerWakelockManager writes, stamped in local time. */
	function logWakelock(action, reason, composerId) {
		const now = new Date();
		const pad = (value, width = 2) => String(value).padStart(width, "0");
		const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
			+ `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
		wakelockId += 1;
		fs.appendFileSync(
			rendererLog,
			`${stamp} [info] [ComposerWakelockManager] ${action} wakelock id=${wakelockId} reason="${reason}" `
				+ `composerId=${composerId}\n`,
		);
	}

	/** The stand-in for Cursor's approval commands: answer the pending request, or queue the next one. */
	function approve() {
		if (pending !== undefined) {
			const composerId = pending;
			pending = undefined;

			// Cursor resumes the agent just after the command returns, never before.
			setTimeout(() => {
				logWakelock("Acquired", "agent-loop-resumed", composerId);
				resolved += 1;
				writeStatus();
			}, RESUME_DELAY_MS);
			return;
		}

		if (!requestScheduled && issued < requestedCount()) {
			requestScheduled = true;
			setTimeout(() => {
				requestScheduled = false;
				pending = crypto.randomUUID();
				issued += 1;
				logWakelock("Released", "user-approval-requested", pending);
				writeStatus();
			}, NEXT_REQUEST_DELAY_MS);
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("composer.approvePendingShellToolDecision", approve),
		vscode.commands.registerCommand("composer.approvePendingShellToolDecisionAllowlist", approve),
		vscode.commands.registerCommand("composer.skipPendingShellToolDecision", () => undefined),
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
