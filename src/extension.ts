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

/** Extension-storage key for the aggregate metrics of the user's current local day. */
const DAILY_METRICS_KEY = "dailyMetrics";

/** Limit extension-storage writes while automatic approval is active. */
const DAILY_METRICS_PERSIST_INTERVAL_MS = 60_000;

/** How long after an invocation a terminal execution may still be related to it. */
const PROBE_CORRELATION_MS = 2_000;

/** Grace period for the Output view to finish restoring its previous channel. */
const OUTPUT_SETTLE_MS = 250;

/**
 * How long automatic approval has been active, shared by the in-memory session
 * and persisted daily buckets.
 *
 * Deliberately not a count of approvals. Cursor's approval command resolves to
 * `undefined` whether it approved a request or found nothing pending, and the
 * pending state lives in renderer-side services that extensions cannot read, so
 * the number of approvals actually granted is not observable. Counting command
 * invocations instead just restates the poll interval, so this tracks the one
 * thing that is both true and worth knowing: how long the confirmation step has
 * been bypassed.
 */
interface ExposureMetrics {
	unsuccessfulAttempts: number;
	enabledDurationMs: number;
	enabledSince: number | undefined;
	lastAttemptAt: number | undefined;
}

interface DailyMetrics extends ExposureMetrics {
	date: string;
}

/**
 * Terminal activity an approved shell tool call would produce.
 *
 * Experimental, and reported only through logs and diagnostics: Cursor appears
 * to run agent commands through its own pseudoterminal service, so these events
 * may never fire. Recording them is how we find out whether a genuine approval
 * count is reachable.
 */
interface ProbeMetrics {
	terminalsOpened: number;
	shellIntegrationsActivated: number;
	executionsStarted: number;
	executionsNearInvocation: number;
	lastExecution: string | undefined;
}

// ---------------------------------------------------------------------------
// Module state (initialized in activate)
// ---------------------------------------------------------------------------

let output: vscode.LogOutputChannel;
let statusBar: vscode.StatusBarItem | undefined;
let extensionVersion = "unknown";
let extensionContext: vscode.ExtensionContext | undefined;
let extensionUri: vscode.Uri | undefined;

/** `setInterval` handle for the approval poll loop; undefined when stopped. */
let timer: ReturnType<typeof setInterval> | undefined;

/** Consecutive `executeCommand` failures used to decide when to stop polling. */
let consecutiveErrorCount = 0;

/** Message from the most recent failed approval attempt, for diagnostics. */
let lastError: string | undefined;

/** Cached result of the last `checkCommandAvailability` call. */
let commandAvailable: boolean | undefined;

/** Priority the current status bar item was created with. */
let statusBarPriority: number | undefined;

/** Metrics reset whenever this extension host activates. */
let sessionMetrics: ExposureMetrics = createExposureMetrics();

/** Metrics persisted for the user's current local calendar day. */
let dailyMetrics: DailyMetrics = createDailyMetrics();

/** Timestamp of the last persisted daily-metrics checkpoint. */
let lastDailyMetricsPersistedAt = 0;

/** Start of the current uninterrupted active stretch, for "Active since". */
let activeSince: number | undefined;

/** Rendered tooltip currently assigned, so it is only reassigned when it changes. */
let lastTooltipValue: string | undefined;

/** When the approval command was last invoked, used to correlate probe events. */
let lastInvocationAt: number | undefined;

const probeMetrics: ProbeMetrics = {
	terminalsOpened: 0,
	shellIntegrationsActivated: 0,
	executionsStarted: 0,
	executionsNearInvocation: 0,
	lastExecution: undefined,
};

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
// Metric tracking
// ---------------------------------------------------------------------------

/** Build a local YYYY-MM-DD key so "Today" follows the user's calendar. */
function localDateKey(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function createExposureMetrics(): ExposureMetrics {
	return {
		unsuccessfulAttempts: 0,
		enabledDurationMs: 0,
		enabledSince: undefined,
		lastAttemptAt: undefined,
	};
}

function createDailyMetrics(now = new Date()): DailyMetrics {
	return { date: localDateKey(now), ...createExposureMetrics() };
}

/** Return accumulated enabled time, including the currently active interval. */
function enabledDuration(metrics: ExposureMetrics, now = Date.now()): number {
	return metrics.enabledDurationMs + (metrics.enabledSince === undefined ? 0 : now - metrics.enabledSince);
}

/** Persist elapsed enabled time into a bucket without changing whether it is active. */
function checkpointEnabledDuration(metrics: ExposureMetrics, now = Date.now()): void {
	if (metrics.enabledSince === undefined) {
		return;
	}

	metrics.enabledDurationMs += now - metrics.enabledSince;
	metrics.enabledSince = now;
}

/**
 * Discard a stale active timestamp from an earlier extension host. VS Code
 * normally calls deactivate, but a crash must not count time while Cursor was
 * closed as enabled time.
 */
function loadDailyMetrics(context: vscode.ExtensionContext): void {
	const stored = context.globalState.get<DailyMetrics>(DAILY_METRICS_KEY);
	const today = localDateKey();

	if (
		stored?.date === today
		&& typeof stored.unsuccessfulAttempts === "number"
		&& typeof stored.enabledDurationMs === "number"
	) {
		// Rebuilt field by field rather than spread so that keys from earlier
		// versions of this shape are dropped on the next write.
		dailyMetrics = {
			date: today,
			unsuccessfulAttempts: stored.unsuccessfulAttempts,
			enabledDurationMs: stored.enabledDurationMs,
			enabledSince: undefined,
			lastAttemptAt: typeof stored.lastAttemptAt === "number" ? stored.lastAttemptAt : undefined,
		};
		return;
	}

	dailyMetrics = createDailyMetrics();
}

/** Start a new current-day bucket whenever the local date changes. */
function rollDailyMetricsIfNeeded(now = new Date()): boolean {
	if (dailyMetrics.date === localDateKey(now)) {
		return false;
	}

	dailyMetrics = createDailyMetrics(now);
	if (isEnabled()) {
		// The current day began at local midnight, so retain enabled time that
		// accrued between midnight and this timer's first post-midnight tick.
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		dailyMetrics.enabledSince = midnight.getTime();
	}
	lastDailyMetricsPersistedAt = 0;
	return true;
}

/** Store a checkpoint no more than once per minute unless the caller forces it. */
function persistDailyMetrics(force = false): void {
	if (!extensionContext) {
		return;
	}

	const now = Date.now();
	if (!force && now - lastDailyMetricsPersistedAt < DAILY_METRICS_PERSIST_INTERVAL_MS) {
		return;
	}

	checkpointEnabledDuration(dailyMetrics, now);
	lastDailyMetricsPersistedAt = now;
	void extensionContext.globalState.update(DAILY_METRICS_KEY, dailyMetrics).then(
		undefined,
		(error) => output.warn(`Unable to save daily metrics: ${String(error)}`),
	);
}

/** Start or checkpoint enabled-duration tracking when the setting changes. */
function updateEnabledDurationTracking(enabled: boolean): void {
	const now = Date.now();
	const rolledDay = rollDailyMetricsIfNeeded(new Date(now));

	if (enabled) {
		sessionMetrics.enabledSince ??= now;
		dailyMetrics.enabledSince ??= now;

		// Unlike `enabledSince`, this survives duration checkpoints so the
		// dashboard can report when the current active stretch began.
		activeSince ??= now;
	} else {
		checkpointEnabledDuration(sessionMetrics, now);
		checkpointEnabledDuration(dailyMetrics, now);
		sessionMetrics.enabledSince = undefined;
		dailyMetrics.enabledSince = undefined;
		activeSince = undefined;
	}

	persistDailyMetrics(rolledDay || !enabled);
}

/** Note that the poll loop ran, so diagnostics can show it is alive. */
function recordPoll(): boolean {
	const now = Date.now();
	const rolledDay = rollDailyMetricsIfNeeded(new Date(now));
	sessionMetrics.lastAttemptAt = now;
	dailyMetrics.lastAttemptAt = now;
	persistDailyMetrics(rolledDay);
	return rolledDay;
}

/** Record a failed automatic command invocation in both visible metric buckets. */
function recordUnsuccessfulAttempt(): void {
	sessionMetrics.unsuccessfulAttempts++;
	dailyMetrics.unsuccessfulAttempts++;
	persistDailyMetrics(true);
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
async function approveOnce(reason: string): Promise<boolean> {
	const command = APPROVE_COMMANDS[currentMode()];
	lastInvocationAt = Date.now();

	try {
		await vscode.commands.executeCommand(command);
		consecutiveErrorCount = 0;
		output.debug(`Invoked ${command} (${reason})`);
		return true;
	} catch (error) {
		consecutiveErrorCount++;
		lastError = error instanceof Error ? error.message : String(error);
		output.error(`Failed to invoke ${command}: ${lastError}`);

		// A command that reliably throws will never start working; turn off
		// rather than log an identical failure on every interval.
		if (consecutiveErrorCount >= 3 && timer) {
			output.error("Disabling automatic approval after repeated failures.");
			await config().update("enabled", false, vscode.ConfigurationTarget.Global);
			void vscode.window.showErrorMessage(
				`Cursor Approve: disabled after repeated failures invoking ${command}.`,
			);
		}

		return false;
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

	const rolledDay = recordPoll();
	const successful = await approveOnce("poll");

	if (!successful) {
		recordUnsuccessfulAttempt();
		updateStatusBar();
		return;
	}

	if (rolledDay) {
		updateStatusBar();
		return;
	}

	refreshTooltip();
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

/**
 * Commands explicitly trusted by the dashboard's Markdown links. Toggling from
 * the dashboard grants nothing beyond clicking the status bar item itself.
 */
const DASHBOARD_COMMANDS = [
	"cursorApprove.toggle",
	"cursorApprove.diagnose",
	"workbench.action.openSettings",
] as const;

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
 * Apply highlight styling while automatic approval is active.
 *
 * The extension host allowlists exactly two status bar backgrounds
 * (`statusBarItem.errorBackground` and `statusBarItem.warningBackground`) and
 * forces the matching foreground whenever one is set. Color customizations are
 * parsed as literal hex, and there is no API to resolve a theme color to a
 * value, so a filled item can never track the theme accent. Tinting the
 * foreground via `textLink.foreground` is the only style that follows it.
 */
function applyStatusBarStyle(item: vscode.StatusBarItem, enabled: boolean): void {
	if (!enabled) {
		item.backgroundColor = undefined;
		item.color = undefined;
		return;
	}

	switch (statusBarStyle()) {
		case "background":
			item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
			item.color = undefined;
			break;
		case "foreground":
			item.backgroundColor = undefined;
			item.color = activeColor();
			break;
		case "none":
			item.backgroundColor = undefined;
			item.color = undefined;
			break;
	}
}

/**
 * Create the status bar item, recreating it when the configured priority
 * changes. VS Code only accepts a priority when the item is created, so the
 * position cannot be updated in place.
 */
function ensureStatusBarItem(): vscode.StatusBarItem {
	const priority = config().get<number>("statusBarPriority", -100);

	if (statusBar && statusBarPriority === priority) {
		return statusBar;
	}

	statusBar?.dispose();
	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
	statusBar.command = "cursorApprove.toggle";
	statusBarPriority = priority;
	lastTooltipValue = undefined;
	extensionContext?.subscriptions.push(statusBar);

	return statusBar;
}

/**
 * Format a duration no finer than a minute. The dashboard is reassigned
 * whenever its text changes, so a seconds component would redraw the hover
 * every second and bring back the flicker it was written to avoid.
 */
function formatDuration(durationMs: number): string {
	const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}

	// Entity rather than "<" because the dashboard renders with HTML support.
	return totalMinutes === 0 ? "&lt;1m" : `${totalMinutes}m`;
}

function formatClockTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatInterval(intervalMs: number): string {
	return intervalMs % 1000 === 0 ? `${intervalMs / 1000}s` : `${intervalMs} ms`;
}

/** Format a count with thousands separators and a matching noun. */
function formatCount(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** Escape a dynamic value before embedding it in a Markdown dashboard. */
function escapeMarkdown(value: string): string {
	return value.replace(/([\\`*_[\]<>&])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

/** Build a safe, theme-native dashboard for the status bar hover tooltip. */
function statusBarTooltip(enabled: boolean): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	const now = Date.now();
	const settingsQuery = encodeURIComponent(JSON.stringify(SECTION));

	// Command execution remains opt-in: only the footer links below can run.
	markdown.isTrusted = { enabledCommands: DASHBOARD_COMMANDS };
	markdown.supportHtml = true;
	markdown.baseUri = extensionUri?.with({ path: `${extensionUri.path}/` });

	if (extensionUri) {
		markdown.appendMarkdown('<img src="./logo512.png" width="16" height="16" alt="" />&nbsp;&nbsp;');
	}

	// Identity on the first line, live state on the second, so the eye lands on
	// the name and then on whether the extension is approving.
	markdown.appendMarkdown(`**Cursor Approve**&nbsp; v${escapeMarkdown(extensionVersion)}\n\n`);

	const state = [
		`${enabled ? "$(check-all)" : "$(circle-slash)"} **${enabled ? "Active" : "Inactive"}**`,
		`\`${currentMode()}\``,
	];

	if (timer !== undefined) {
		state.push(`every ${formatInterval(config().get<number>("intervalMs", 1000))}`);
	}

	markdown.appendMarkdown(`${state.join(" · ")}\n\n`);

	// Time active is the honest measure of what this extension does: how long the
	// confirmation step has been bypassed. Approvals granted are not observable.
	if (enabled && activeSince !== undefined) {
		markdown.appendMarkdown(`Active since ${formatClockTime(activeSince)}  \n`);
	}

	markdown.appendMarkdown(
		`Session ${formatDuration(enabledDuration(sessionMetrics, now))} · Today ${
			formatDuration(enabledDuration(dailyMetrics, now))
		}\n\n`,
	);

	// Exceptions get their own line only while they apply, so a healthy hover
	// stays short and a real problem cannot hide among rows of zeroes.
	if (commandAvailable === false) {
		markdown.appendMarkdown("$(warning) Cursor approval command not available\n\n");
	}

	if (dailyMetrics.unsuccessfulAttempts > 0) {
		markdown.appendMarkdown(
			`$(warning) ${formatCount(dailyMetrics.unsuccessfulAttempts, "unsuccessful attempt")} today\n\n`,
		);
	}

	if (config().get<boolean>("onlyWhenFocused", false)) {
		markdown.appendMarkdown("$(eye) Approving only while this window is focused\n\n");
	}

	// Allowlist mode outlives the session, so it deserves to be called out.
	if (currentMode() === "allowlist") {
		markdown.appendMarkdown("$(law) Approved commands are added to the allowlist\n\n");
	}

	markdown.appendMarkdown("---\n\n");
	markdown.appendMarkdown(
		`[${enabled ? "$(circle-slash) Turn Off" : "$(check-all) Turn On"}](command:cursorApprove.toggle "${
			enabled ? "Stop" : "Start"
		} approving automatically")&nbsp; · &nbsp;[$(output) Diagnostics](command:cursorApprove.diagnose "Open the Cursor Approve output channel")&nbsp; · &nbsp;[$(gear) Settings](command:workbench.action.openSettings?${settingsQuery} "Open Cursor Approve settings")`,
	);

	return markdown;
}

/**
 * Keep the dashboard current without redrawing a hover that is already open.
 *
 * VS Code has no event for a status bar tooltip being shown, so the only way to
 * be accurate when the user looks is to keep the value fresh. Reassigning it
 * redraws an open hover, so the tooltip is replaced only when its rendered text
 * actually differs, which at minute granularity is about once a minute.
 */
function refreshTooltip(): void {
	if (!statusBar || !config().get<boolean>("showStatusBarItem", true)) {
		return;
	}

	const tooltip = statusBarTooltip(isEnabled());

	if (tooltip.value === lastTooltipValue) {
		return;
	}

	statusBar.tooltip = tooltip;
	lastTooltipValue = tooltip.value;
}

/** Sync status bar text, tooltip, and highlight with the current enabled state. */
function updateStatusBar(): void {
	const item = ensureStatusBarItem();

	if (!config().get<boolean>("showStatusBarItem", true)) {
		item.hide();
		return;
	}

	const enabled = isEnabled();
	item.text = enabled ? "$(check-all) Auto Approve" : "$(circle-slash) Auto Approve";
	applyStatusBarStyle(item, enabled);
	refreshTooltip();
	item.show();
}

/**
 * React to any settings change under `cursorApprove.*` — start or stop polling
 * and refresh the status bar.
 */
function applyConfiguration(): void {
	const enabled = isEnabled();
	updateEnabledDurationTracking(enabled);

	if (enabled) {
		startPolling();
	} else {
		stopPolling();
		output.info("Automatic approval is off.");
	}

	updateStatusBar();
}

/**
 * Watch terminal activity that an approved shell tool call would produce.
 *
 * Nothing here is shown in the dashboard or used to claim an approval happened.
 * It exists to answer one open question: whether an approval Cursor grants is
 * visible from the extension host at all. Cursor appears to run agent commands
 * through its own pseudoterminal service, in which case none of these events
 * will fire and a genuine approval count stays out of reach.
 */
function registerApprovalProbe(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal((terminal) => {
			probeMetrics.terminalsOpened++;
			output.debug(`probe: terminal opened '${terminal.name}'`);
		}),
	);

	// Shell integration landed in VS Code 1.93; stay defensive about the host.
	if (typeof vscode.window.onDidChangeTerminalShellIntegration === "function") {
		context.subscriptions.push(
			vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => {
				probeMetrics.shellIntegrationsActivated++;
				output.debug(`probe: shell integration active in '${terminal.name}'`);
			}),
		);
	}

	if (typeof vscode.window.onDidStartTerminalShellExecution === "function") {
		context.subscriptions.push(
			vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
				const sinceInvocation = lastInvocationAt === undefined ? undefined : Date.now() - lastInvocationAt;

				probeMetrics.executionsStarted++;
				if (sinceInvocation !== undefined && sinceInvocation <= PROBE_CORRELATION_MS) {
					probeMetrics.executionsNearInvocation++;
				}

				// Truncated because this is the user's own command line.
				probeMetrics.lastExecution = execution.commandLine.value.slice(0, 60);
				output.debug(
					`probe: execution in '${terminal.name}' ${
						sinceInvocation ?? "?"
					}ms after last invocation: ${probeMetrics.lastExecution}`,
				);
			}),
		);
	}
}

/** Resolve on a later turn of the event loop, so the workbench can settle. */
function delay(ms = 0): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Open the Output panel with this extension's channel selected.
 *
 * `output.show()` alone is unreliable when invoked from the command palette
 * because focus returns to the editor as the palette closes. Revealing the
 * panel first fixes that, but the panel restores whichever channel was last
 * selected, and that restoration can land after the focus command resolves and
 * quietly undo the selection. Selecting the channel on a later turn and once
 * more after the view settles is what makes the result stick.
 */
async function revealOutput(): Promise<void> {
	// Let the Command Palette finish closing before changing the active panel.
	await delay();
	await vscode.commands.executeCommand("workbench.panel.output.focus");

	await delay();
	output.show(true);

	await delay(OUTPUT_SETTLE_MS);
	output.show(true);
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
	extensionVersion = String(context.extension.packageJSON.version);
	extensionContext = context;
	extensionUri = context.extensionUri;
	loadDailyMetrics(context);

	context.subscriptions.push(output);
	ensureStatusBarItem();
	registerApprovalProbe(context);

	await checkCommandAvailability();

	context.subscriptions.push(
		vscode.commands.registerCommand("cursorApprove.toggle", async () => {
			const next = !isEnabled();
			await config().update("enabled", next, vscode.ConfigurationTarget.Global);

			if (next) {
				consecutiveErrorCount = 0;
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
			const rolledDay = rollDailyMetricsIfNeeded();
			persistDailyMetrics(rolledDay);
			updateStatusBar();

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
			output.info(`activeSince        ${activeSince ?? "inactive"}`);
			output.info(`sessionEnabledMs   ${enabledDuration(sessionMetrics)}`);
			output.info(`sessionUnsuccessful ${sessionMetrics.unsuccessfulAttempts}`);
			output.info(`sessionLastPoll    ${sessionMetrics.lastAttemptAt ?? "none"}`);
			output.info(`today              ${dailyMetrics.date}`);
			output.info(`todayEnabledMs     ${enabledDuration(dailyMetrics)}`);
			output.info(`todayUnsuccessful  ${dailyMetrics.unsuccessfulAttempts}`);
			output.info(`todayLastPoll      ${dailyMetrics.lastAttemptAt ?? "none"}`);
			output.info(`consecutiveUnsuccessful ${consecutiveErrorCount}`);
			output.info(`lastUnsuccessful   ${lastError ?? "none"}`);
			output.info("--- Approval probe (experimental) ---");
			output.info(`terminalsOpened    ${probeMetrics.terminalsOpened}`);
			output.info(`shellIntegrations  ${probeMetrics.shellIntegrationsActivated}`);
			output.info(`executionsStarted  ${probeMetrics.executionsStarted}`);
			output.info(`executionsCorrelated ${probeMetrics.executionsNearInvocation}`);
			output.info(`lastExecution      ${probeMetrics.lastExecution ?? "none"}`);
			output.info("Cursor's approval command resolves the same way whether it approved a");
			output.info("request or found nothing pending, and the pending state is renderer-only,");
			output.info("so approvals granted cannot be counted. The probe records the terminal");
			output.info("activity an approval would cause, to test whether that ever changes.");
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

/** Tear down polling and save the current enabled-duration checkpoint. */
export async function deactivate(): Promise<void> {
	stopPolling();
	const now = Date.now();
	rollDailyMetricsIfNeeded(new Date(now));
	checkpointEnabledDuration(sessionMetrics, now);
	checkpointEnabledDuration(dailyMetrics, now);
	sessionMetrics.enabledSince = undefined;
	dailyMetrics.enabledSince = undefined;
	activeSince = undefined;

	if (extensionContext) {
		await extensionContext.globalState.update(DAILY_METRICS_KEY, dailyMetrics);
	}
}
