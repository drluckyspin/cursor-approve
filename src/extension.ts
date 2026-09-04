import * as vscode from "vscode";

/**
 * Cursor registers these internally with `f1: true`, so they are ordinary
 * workbench commands that the extension host can invoke. Each is a no-op when
 * no tool call is awaiting a decision, which is what makes blind polling safe.
 */
const APPROVE_COMMANDS = {
	run: "composer.approvePendingShellToolDecision",
	allowlist: "composer.approvePendingShellToolDecisionAllowlist",
} as const;

type ApproveMode = keyof typeof APPROVE_COMMANDS;

const SECTION = "cursorApprove";

let output: vscode.LogOutputChannel;
let statusBar: vscode.StatusBarItem;
let timer: ReturnType<typeof setInterval> | undefined;

let pollCount = 0;
let errorCount = 0;
let lastError: string | undefined;
let commandAvailable: boolean | undefined;

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(SECTION);
}

function currentMode(): ApproveMode {
	return config().get<string>("mode") === "allowlist" ? "allowlist" : "run";
}

function isEnabled(): boolean {
	return config().get<boolean>("enabled", false);
}

/**
 * Cursor's approval commands are not part of the public API, so a build that
 * renames or drops them should degrade to a clear warning rather than a silent
 * no-op loop.
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

async function approveOnce(reason: string): Promise<void> {
	const command = APPROVE_COMMANDS[currentMode()];

	try {
		await vscode.commands.executeCommand(command);
		output.debug(`Invoked ${command} (${reason})`);
	} catch (error) {
		errorCount++;
		lastError = error instanceof Error ? error.message : String(error);
		output.error(`Failed to invoke ${command}: ${lastError}`);

		// A command that reliably throws will never start working; stop rather
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

async function tick(): Promise<void> {
	if (config().get<boolean>("onlyWhenFocused", false) && !vscode.window.state.focused) {
		return;
	}

	pollCount++;
	await approveOnce("poll");
}

function stopPolling(): void {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

function startPolling(): void {
	stopPolling();

	const interval = config().get<number>("intervalMs", 1000);
	timer = setInterval(() => void tick(), interval);
	output.info(`Polling every ${interval}ms in '${currentMode()}' mode.`);
}

function updateStatusBar(): void {
	if (!config().get<boolean>("showStatusBarItem", true)) {
		statusBar.hide();
		return;
	}

	const enabled = isEnabled();
	statusBar.text = enabled ? "$(check-all) Auto Approve" : "$(circle-slash) Auto Approve";
	statusBar.tooltip = enabled
		? `Automatically approving pending tool calls in '${currentMode()}' mode. Click to disable.`
		: "Automatic approval is off. Click to enable.";
	statusBar.backgroundColor = enabled
		? new vscode.ThemeColor("statusBarItem.warningBackground")
		: undefined;
	statusBar.show();
}

function applyConfiguration(): void {
	if (isEnabled()) {
		startPolling();
	} else {
		stopPolling();
		output.info("Automatic approval is off.");
	}

	updateStatusBar();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	output = vscode.window.createOutputChannel("Cursor Approve", { log: true });
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = "cursorApprove.toggle";

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

			output.info("--- diagnostics ---");
			output.info(`enabled            ${isEnabled()}`);
			output.info(`polling            ${timer !== undefined}`);
			output.info(`mode               ${currentMode()}`);
			output.info(`command            ${APPROVE_COMMANDS[currentMode()]}`);
			output.info(`commandAvailable   ${available}`);
			output.info(`intervalMs         ${config().get<number>("intervalMs", 1000)}`);
			output.info(`onlyWhenFocused    ${config().get<boolean>("onlyWhenFocused", false)}`);
			output.info(`windowFocused      ${vscode.window.state.focused}`);
			output.info(`polls              ${pollCount}`);
			output.info(`errors             ${errorCount}`);
			output.info(`lastError          ${lastError ?? "none"}`);
			output.info("Cursor's command is silent when nothing is pending, so poll");
			output.info("count is not a count of actual approvals.");
			output.info("--- end diagnostics ---");
			output.show(true);
		}),

		// Discovery helper: Cursor's composer commands are undocumented, and
		// this is how the approval commands above were found in the first place.
		vscode.commands.registerCommand("cursorApprove.listComposerCommands", async () => {
			const all = await vscode.commands.getCommands(true);
			const composer = all.filter((c) => c.startsWith("composer.")).sort();

			output.info(`--- ${composer.length} composer.* commands ---`);
			for (const command of composer) {
				output.info(command);
			}
			output.info("--- end ---");
			output.show(true);
		}),

		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(SECTION)) {
				applyConfiguration();
			}
		}),
	);

	applyConfiguration();
}

export function deactivate(): void {
	stopPolling();
}
