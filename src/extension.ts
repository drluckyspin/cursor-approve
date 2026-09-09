/**
 * Cursor Approve — A Cursor extension.
 *
 * Polls Cursor's internal workbench commands to approve pending agent tool calls
 * without simulating keystrokes or scraping the approval UI. Automatic approval is
 * off by default; users toggle it via the status bar or settings.
 *
 * @see https://github.com/drluckyspin/cursor-approve
 *
 * Copyright (c) 2026 Todd Papaioannou
 * SPDX-License-Identifier: MIT
 */

import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Cursor command surface
// ---------------------------------------------------------------------------

/**
 * Cursor registers approval actions as ordinary workbench commands (`f1: true`).
 * The extension host can invoke them through `vscode.commands.executeCommand`.
 *
 * Each command early-returns when nothing is pending, which is why blind polling
 * on a timer is safe — most ticks are genuine no-ops with no side effects.
 *
 * These identifiers are undocumented and may change between Cursor releases.
 * Use `cursorApprove.listComposerCommands` after upgrading to confirm they still exist.
 */
const APPROVE_COMMANDS = {
	/** Approve the current call only — equivalent to pressing Run. */
	run: "composer.approvePendingShellToolDecision",
	/** Approve and remember the command — equivalent to pressing Always Run. */
	allowlist: "composer.approvePendingShellToolDecisionAllowlist",
} as const;

type ApproveMode = keyof typeof APPROVE_COMMANDS;

/** Prefix for every `contributes.configuration` key in package.json. */
const SECTION = "cursorApprove";

// ---------------------------------------------------------------------------
// Module state (initialized in activate)
// ---------------------------------------------------------------------------

let output: vscode.LogOutputChannel;
let statusBar: vscode.StatusBarItem;
let extensionVersion = "unknown";

/** `setInterval` handle for the approval poll loop; undefined when disarmed. */
let timer: ReturnType<typeof setInterval> | undefined;

/** Total poll ticks since activation — includes no-op ticks when nothing is pending. */
let pollCount = 0;

/** Consecutive `executeCommand` failures; resets when the user re-enables approval. */
let errorCount = 0;

/** Message from the most recent failed approval attempt, for diagnostics. */
let lastError: string | undefined;

/** Cached result of the last `checkCommandAvailability` call. */
let commandAvailable: boolean | undefined;

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(SECTION);
}

function currentMode(): ApproveMode {
	return config().get<string>("mode") === "allowlist" ? "allowlist" : "run";
}

function isEnabled(): boolean {
	return config().get<boolean>("enabled", false);
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * Verify that Cursor has registered the primary approval command.
 *
 * Stock VS Code does not expose `composer.*` commands, so this is the earliest
 * signal that the extension is running in the wrong host. We warn once rather
 * than silently polling a command that will never exist.
 */
async function checkCommandAvailability(): Promise<boolean> {
	const all = await vscode.commands.getCommands(true);
	commandAvailable = all.includes(APPROVE_COMMANDS.run);

	if (!commandAvailable) {
		output.warn(
			`Command '${APPROVE_COMMANDS.run}' is not registered. This extension requires Cursor, not stock VS Code.`,
		);
	}

	return commandAvailable;
}

/**
 * Invoke the configured approval command once.
 *
 * @param reason - Shown in debug logs (`poll`, `manual`, etc.) to distinguish
 *   timer-driven calls from explicit user actions.
 */
async function approveOnce(reason: string): Promise<void> {
	const command = APPROVE_COMMANDS[currentMode()];

	try {
		await vscode.commands.executeCommand(command);
		output.debug(`Invoked ${command} (${reason})`);
	} catch (error) {
		errorCount++;
		lastError = error instanceof Error ? error.message : String(error);
		output.error(`Failed to invoke ${command}: ${lastError}`);

		// A command that reliably throws will never start working; disarm rather
		// than log an identical failure on every interval.
		if (errorCount >= 3 && timer) {
			output.error("Disabling automatic approval after repeated failures.");
			await config().update("enabled", false, vscode.ConfigurationTarget.Global);
			void vscode.window.showErrorMessage(
				`Cursor Approve: disabled after repeated failures invoking ${command}.`,
			);
		}
	}
}

/**
 * Single poll-cycle callback. Skipped entirely when `onlyWhenFocused` is set and
 * this window does not have focus.
 */
async function tick(): Promise<void> {
	if (config().get<boolean>("onlyWhenFocused", false) && !vscode.window.state.focused) {
		return;
	}

	pollCount++;
	const errorsBeforePoll = errorCount;
	await approveOnce("poll");

	// Reassigning a visible status-bar tooltip makes Cursor redraw it, which
	// causes flicker while it is hovered. Successful polls only change the
	// counter, so refresh the snapshot only when an error changes.
	if (errorCount !== errorsBeforePoll) {
		updateStatusBar();
	}
}

function stopPolling(): void {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

/** (Re)start the poll loop using the current `intervalMs` setting. */
function startPolling(): void {
	stopPolling();

	const interval = config().get<number>("intervalMs", 1000);
	timer = setInterval(() => void tick(), interval);
	output.info(`Polling every ${interval}ms in '${currentMode()}' mode.`);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

type StatusBarStyle = "background" | "foreground" | "none";

function statusBarStyle(): StatusBarStyle {
	const style = config().get<string>("statusBarStyle", "foreground");
	return style === "background" || style === "none" ? style : "foreground";
}

/**
 * Resolve `cursorApprove.activeColor` to either a literal hex or a theme token.
 * An empty string disables the foreground tint.
 */
function activeColor(): string | vscode.ThemeColor | undefined {
	const id = config().get<string>("activeColor", "textLink.foreground").trim();

	if (!id) {
		return undefined;
	}

	return id.startsWith("#") ? id : new vscode.ThemeColor(id);
}

/**
 * Apply highlight styling while automatic approval is armed.
 *
 * The extension host allowlists exactly two status bar backgrounds
 * (`statusBarItem.errorBackground` and `statusBarItem.warningBackground`) and
 * forces the matching foreground whenever one is set. Color customizations are
 * parsed as literal hex, and there is no API to resolve a theme color to a
 * value, so a filled item can never track the theme accent. Tinting the
 * foreground via `textLink.foreground` is the only style that follows it.
 */
function applyStatusBarStyle(enabled: boolean): void {
	if (!enabled) {
		statusBar.backgroundColor = undefined;
		statusBar.color = undefined;
		return;
	}

	switch (statusBarStyle()) {
		case "background":
			statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
			statusBar.color = undefined;
			break;
		case "foreground":
			statusBar.backgroundColor = undefined;
			statusBar.color = activeColor();
			break;
		case "none":
			statusBar.backgroundColor = undefined;
			statusBar.color = undefined;
			break;
	}
}

/** Build a current, compact diagnostic view for the status bar hover tooltip. */
function statusBarTooltip(enabled: boolean): string {
	return [
		`Automatic approval is ${enabled ? "on" : "off"}. Click to ${enabled ? "disable" : "enable"}.`,
		"",
		`Version: ${extensionVersion}`,
		`Mode: ${currentMode()}`,
		`Command available: ${commandAvailable ?? "checking"}`,
		`Polling: ${timer !== undefined}`,
		`Interval: ${config().get<number>("intervalMs", 1000)} ms`,
		`Only when focused: ${config().get<boolean>("onlyWhenFocused", false)}`,
		`Window focused: ${vscode.window.state.focused}`,
		`Polls: ${pollCount}`,
		`Unsuccessful attempts: ${errorCount}`,
		`Last unsuccessful result: ${lastError ?? "none"}`,
	].join("\n");
}

/** Sync status bar text, tooltip, and highlight with the current enabled state. */
function updateStatusBar(): void {
	if (!config().get<boolean>("showStatusBarItem", true)) {
		statusBar.hide();
		return;
	}

	const enabled = isEnabled();
	statusBar.text = enabled ? "$(check-all) Auto Approve" : "$(circle-slash) Auto Approve";
	statusBar.tooltip = statusBarTooltip(enabled);
	applyStatusBarStyle(enabled);
	statusBar.show();
}

/**
 * React to any settings change under `cursorApprove.*` — start or stop polling
 * and refresh the status bar.
 */
function applyConfiguration(): void {
	if (isEnabled()) {
		startPolling();
	} else {
		stopPolling();
		output.info("Automatic approval is off.");
	}

	updateStatusBar();
}

/**
 * Open the Output panel with this extension's channel selected.
 *
 * `output.show()` alone is unreliable when invoked from the command palette
 * because focus returns to the editor as the palette closes.
 */
async function revealOutput(): Promise<void> {
	// Let the Command Palette finish closing before changing the active panel.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await vscode.commands.executeCommand("workbench.panel.output.focus");

	// Select this channel last: focusing the panel can otherwise restore the
	// previously selected Output channel after `output.show()` runs.
	output.show(false);
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

/**
 * Called when the extension is activated (`onStartupFinished`).
 *
 * Registers commands, wires the status bar toggle, and applies the user's
 * current settings. Does not enable automatic approval unless
 * `cursorApprove.enabled` is already true.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel("Cursor Approve", { log: true });
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = "cursorApprove.toggle";
	extensionVersion = String(context.extension.packageJSON.version);

	context.subscriptions.push(output, statusBar);

	await checkCommandAvailability();

	context.subscriptions.push(
		vscode.commands.registerCommand("cursorApprove.toggle", async () => {
			const next = !isEnabled();
			await config().update("enabled", next, vscode.ConfigurationTarget.Global);

			if (next) {
				errorCount = 0;
			}

			void vscode.window.setStatusBarMessage(
				`Cursor Approve: automatic approval ${next ? "on" : "off"}`,
				2000,
			);
		}),
		vscode.commands.registerCommand("cursorApprove.approveOnce", async () => {
			await approveOnce("manual");
			void vscode.window.setStatusBarMessage("Cursor Approve: sent approval", 2000);
		}),
		vscode.commands.registerCommand("cursorApprove.diagnose", async () => {
			const available = await checkCommandAvailability();

			output.info("--- Diagnostics ---");
			output.info(`version            ${extensionVersion}`);
			output.info(`enabled            ${isEnabled()}`);
			output.info(`polling            ${timer !== undefined}`);
			output.info(`mode               ${currentMode()}`);
			output.info(`command            ${APPROVE_COMMANDS[currentMode()]}`);
			output.info(`commandAvailable   ${available}`);
			output.info(`intervalMs         ${config().get<number>("intervalMs", 1000)}`);
			output.info(`onlyWhenFocused    ${config().get<boolean>("onlyWhenFocused", false)}`);
			output.info(`windowFocused      ${vscode.window.state.focused}`);
			output.info(`polls              ${pollCount}`);
			output.info(`unsuccessful       ${errorCount}`);
			output.info(`lastUnsuccessful   ${lastError ?? "none"}`);
			output.info("Cursor's command is silent when nothing is pending, so poll");
			output.info("count is not a count of actual approvals.");
			output.info("--- End Diagnostics ---");
			await revealOutput();
		}),
		// Discovery helper: Cursor's composer commands are undocumented, and
		// this is how the approval command IDs above were found in the first place.
		vscode.commands.registerCommand("cursorApprove.listComposerCommands", async () => {
			const all = await vscode.commands.getCommands(true);
			const composer = all.filter((c) => c.startsWith("composer.")).sort();

			output.info(`--- ${composer.length} composer.* commands ---`);
			for (const command of composer) {
				output.info(command);
			}
			output.info("--- end ---");
			await revealOutput();
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(SECTION)) {
				applyConfiguration();
			}
		}),
	);

	applyConfiguration();
}

/** Tear down the poll loop when the extension host shuts down. */
export function deactivate(): void {
	stopPolling();
}
