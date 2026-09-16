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

/**
 * File under `globalStorageUri` holding the day's totals for every window.
 *
 * A file rather than `globalState`, because every Cursor window runs its own
 * extension host: each holds its own in-memory copy of that storage, never sees
 * another window's writes, and overwrites the shared value wholesale on its own
 * checkpoint. With four windows open, the day's totals became whichever window
 * happened to write last. A file can be re-read immediately before each write
 * and merged, which is what makes the numbers add up across windows.
 */
const SHARED_DAILY_FILE = "daily-metrics.json";

/** Keys from the builds that kept the day's totals in per-window storage. */
const LEGACY_DAILY_KEYS = ["dailyMetrics", "dailyMetrics.v2"] as const;

/** How often a window merges its pending counts into the shared file. */
const SHARED_FLUSH_INTERVAL_MS = 15_000;

/**
 * Longest gap between shared checkpoints that still counts as active time.
 *
 * The shared clock only advances when some window flushes, so this has to
 * exceed the flush interval; a gap beyond it means every window was suspended
 * or closed, and that time was not active.
 */
const SHARED_FOLD_TOLERANCE_MS = SHARED_FLUSH_INTERVAL_MS * 3;

/**
 * Terminal name prefixes Cursor uses for the terminals its agent runs commands
 * in. This is the same test Cursor applies internally:
 * `name?.startsWith("Cursor (") || name?.startsWith("Agent Terminal")`.
 */
const AGENT_TERMINAL_PREFIXES = ["Agent Terminal", "Cursor ("] as const;

/**
 * Upper bounds for the measured delay between invoking the approval command and
 * an agent command starting.
 *
 * A command this extension approves should start within a few frames of the
 * invocation, while one Cursor auto-ran from its own allowlist starts whenever
 * the agent asked for it. If the delays cluster tightly, attribution is
 * possible; if they spread across the poll interval, they are coincidence.
 */
const PROBE_LATENCY_BUCKETS_MS = [100, 250, 500, 1000] as const;

/**
 * Delay within which an agent command is credited to this extension.
 *
 * Measured, not guessed. Commands that needed approval started 44, 50, 57, and
 * 75ms after the invocation that released them, because the execution begins a
 * few frames after `executeCommand` resolves. Commands Cursor auto-ran from its
 * own allowlist or sandbox landed uniformly across the poll interval — 56, 155,
 * 248, 262, 607, 662, 908ms — since nothing was pending and the poll had no
 * effect on them.
 *
 * The two populations therefore separate on latency alone. Every real approval
 * falls inside this window; the error is unrelated executions that happen to
 * land in it, at a rate of roughly this window divided by the poll interval, so
 * about one in ten auto-run commands at the default one second. The count is
 * deliberately not presented with a margin: it is close, and a visible error
 * bar would cost more clarity than the precision is worth.
 */
const APPROVAL_ATTRIBUTION_MS = 100;

/** Cap on distinct terminal names tracked, since a name follows the running process. */
const PROBE_TERMINAL_NAME_LIMIT = 12;

/** Grace period for the Output view to finish restoring its previous channel. */
const OUTPUT_SETTLE_MS = 250;

/** Floor for the active-time gap tolerance, so a fast poll rate stays forgiving. */
const MIN_ACTIVE_GAP_TOLERANCE_MS = 5_000;

/**
 * What this window has seen since its extension host started.
 *
 * Active time is deliberately not a count of approvals granted. Cursor's
 * approval command resolves to `undefined` whether it approved a request or
 * found nothing pending, and the pending state lives in renderer-side services
 * extensions cannot read, so how long the confirmation step has been bypassed
 * is the part that can be measured directly.
 */
interface ExposureMetrics {
	unsuccessfulAttempts: number;
	enabledDurationMs: number;
	enabledSince: number | undefined;
	lastAttemptAt: number | undefined;
	/**
	 * Commands that started in an agent terminal while approval was active.
	 *
	 * Includes commands Cursor auto-ran from its own allowlist or sandbox, which
	 * needed no approval from anyone.
	 */
	commandsRun: number;

	/** The subset of those commands this extension released, by `APPROVAL_ATTRIBUTION_MS`. */
	commandsApproved: number;
}

/**
 * The local day's totals, summed across every window through the shared file.
 *
 * Counts add up because each window contributes only what it saw. Active time
 * is folded once, by whichever window checkpoints next, because approval is a
 * global setting: two windows armed for an hour is one hour of exposure, not
 * two.
 */
interface SharedDailyRecord {
	date: string;
	activeMs: number;
	lastCheckpointAt: number;
	unsuccessfulAttempts: number;
	commandsRun: number;
	commandsApproved: number;
}

/** Counts this window has not yet merged into the shared file. */
interface PendingDailyDelta {
	unsuccessfulAttempts: number;
	commandsRun: number;
	commandsApproved: number;
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
	agentExecutions: number;
	/** Executions per terminal name, to tell agent terminals from the user's own. */
	executionsByTerminal: Map<string, number>;
	/** Delay from the last invocation, bucketed by `PROBE_LATENCY_BUCKETS_MS`. */
	latencyBuckets: number[];
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

/** Poll interval the currently open checkpoint window was started under. */
let pollIntervalMs = 1000;

/** Consecutive `executeCommand` failures used to decide when to stop polling. */
let consecutiveErrorCount = 0;

/** Message from the most recent failed approval attempt, for diagnostics. */
let lastError: string | undefined;

/** Cached result of the last `checkCommandAvailability` call. */
let commandAvailable: boolean | undefined;

/** Mode that cached result belongs to, since each mode uses its own command. */
let commandAvailableForMode: ApproveMode | undefined;

/** Priority the current status bar item was created with. */
let statusBarPriority: number | undefined;

/** Metrics reset whenever this extension host activates. */
let sessionMetrics: ExposureMetrics = createExposureMetrics();

/** The shared day's totals as of this window's last merge. */
let sharedDaily: SharedDailyRecord = createSharedDailyRecord();

/** Counts awaiting their next merge into the shared file. */
let pendingDaily: PendingDailyDelta = createPendingDailyDelta();

/** Timestamp of this window's last successful merge. */
let lastSharedFlushAt = 0;

/** The merge currently running, since each one is a read-modify-write. */
let sharedFlushInFlight: Promise<void> | undefined;

/** Start of the current uninterrupted active stretch, for "Active since". */
let activeSince: number | undefined;

/** `setTimeout` handle for the next local-midnight dashboard refresh. */
let rolloverTimer: ReturnType<typeof setTimeout> | undefined;

/** Rendered tooltip currently assigned, so it is only reassigned when it changes. */
let lastTooltipValue: string | undefined;

/** When the approval command was last invoked, used to correlate probe events. */
let lastInvocationAt: number | undefined;

const probeMetrics: ProbeMetrics = {
	terminalsOpened: 0,
	shellIntegrationsActivated: 0,
	executionsStarted: 0,
	agentExecutions: 0,
	executionsByTerminal: new Map(),
	latencyBuckets: new Array(PROBE_LATENCY_BUCKETS_MS.length + 1).fill(0),
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
		commandsRun: 0,
		commandsApproved: 0,
	};
}

function createSharedDailyRecord(now = Date.now()): SharedDailyRecord {
	return {
		date: localDateKey(new Date(now)),
		activeMs: 0,
		lastCheckpointAt: now,
		unsuccessfulAttempts: 0,
		commandsRun: 0,
		commandsApproved: 0,
	};
}

function createPendingDailyDelta(): PendingDailyDelta {
	return { unsuccessfulAttempts: 0, commandsRun: 0, commandsApproved: 0 };
}

function sharedDailyUri(): vscode.Uri | undefined {
	return extensionContext === undefined
		? undefined
		: vscode.Uri.joinPath(extensionContext.globalStorageUri, SHARED_DAILY_FILE);
}

/** Read the shared record, or undefined when it is missing or unreadable. */
async function readSharedDaily(): Promise<SharedDailyRecord | undefined> {
	const uri = sharedDailyUri();
	if (uri === undefined) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));

		if (
			typeof parsed?.date === "string"
			&& typeof parsed.activeMs === "number"
			&& typeof parsed.lastCheckpointAt === "number"
		) {
			return {
				date: parsed.date,
				activeMs: parsed.activeMs,
				lastCheckpointAt: parsed.lastCheckpointAt,
				unsuccessfulAttempts: typeof parsed.unsuccessfulAttempts === "number" ? parsed.unsuccessfulAttempts : 0,
				commandsRun: typeof parsed.commandsRun === "number" ? parsed.commandsRun : 0,
				commandsApproved: typeof parsed.commandsApproved === "number" ? parsed.commandsApproved : 0,
			};
		}
	} catch {
		// Missing on the first run, and a partial write is not worth reporting:
		// the merge below simply starts the day over.
	}

	return undefined;
}

/** Write through a temporary file, so a reader never sees a half-written record. */
async function writeSharedDaily(record: SharedDailyRecord): Promise<void> {
	const uri = sharedDailyUri();
	if (uri === undefined) {
		return;
	}

	const temporary = uri.with({ path: `${uri.path}.${process.pid}.tmp` });
	await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(record)));
	await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
}

/**
 * Merge this window's pending counts into the shared record.
 *
 * Re-reads immediately before writing so concurrent windows accumulate rather
 * than overwrite. Active time is added by whichever window gets here first,
 * measured from the shared checkpoint, so it is counted once no matter how many
 * windows are open.
 */
async function flushSharedDaily(force = false, foldActive = isEnabled()): Promise<void> {
	if (sharedFlushInFlight !== undefined) {
		// Wait rather than interleave: each merge is a read-modify-write, and
		// two of them running together in one window would lose counts.
		await sharedFlushInFlight;

		if (!force) {
			return;
		}
	}

	if (!force && Date.now() - lastSharedFlushAt < SHARED_FLUSH_INTERVAL_MS) {
		return;
	}

	sharedFlushInFlight = mergeSharedDaily(Date.now(), foldActive);

	try {
		await sharedFlushInFlight;
	} finally {
		sharedFlushInFlight = undefined;
	}
}

/** One read-modify-write cycle against the shared record. */
async function mergeSharedDaily(now: number, foldActive: boolean): Promise<void> {
	const merging = pendingDaily;
	pendingDaily = createPendingDailyDelta();

	try {
		let record = await readSharedDaily() ?? createSharedDailyRecord(now);

		if (record.date !== localDateKey(new Date(now))) {
			record = createSharedDailyRecord(now);
		}

		if (foldActive) {
			const elapsed = now - record.lastCheckpointAt;
			if (elapsed > 0 && elapsed <= SHARED_FOLD_TOLERANCE_MS) {
				record.activeMs += elapsed;
			}
		}

		record.lastCheckpointAt = now;
		record.unsuccessfulAttempts += merging.unsuccessfulAttempts;
		record.commandsRun += merging.commandsRun;
		record.commandsApproved += merging.commandsApproved;

		await writeSharedDaily(record);
		sharedDaily = record;
		lastSharedFlushAt = now;
	} catch (error) {
		// Put the counts back so a failed write postpones them rather than
		// dropping them.
		pendingDaily.unsuccessfulAttempts += merging.unsuccessfulAttempts;
		pendingDaily.commandsRun += merging.commandsRun;
		pendingDaily.commandsApproved += merging.commandsApproved;
		output.warn(`Unable to update the shared daily metrics: ${String(error)}`);
	}
}

/** True while the shared record still describes the current local day. */
function sharedDailyIsToday(now = Date.now()): boolean {
	return sharedDaily.date === localDateKey(new Date(now));
}

/** The day's active time, including the interval since the last shared checkpoint. */
function dailyActiveMs(now = Date.now()): number {
	if (!sharedDailyIsToday(now)) {
		return 0;
	}

	const elapsed = isEnabled() ? now - sharedDaily.lastCheckpointAt : 0;
	return sharedDaily.activeMs + (elapsed > 0 && elapsed <= SHARED_FOLD_TOLERANCE_MS ? elapsed : 0);
}

/** A day total including counts this window has not merged yet. */
function dailyCount(field: keyof PendingDailyDelta, now = Date.now()): number {
	return (sharedDailyIsToday(now) ? sharedDaily[field] : 0) + pendingDaily[field];
}

/**
 * Longest gap since the last checkpoint that can still count as active time.
 *
 * Timers do not run while the machine is suspended, so a gap well beyond the
 * poll interval means the extension was not approving anything during it.
 * Counting it would report a closed laptop as active, which is how a day of
 * intermittent use turns into an implausible number of hours.
 *
 * Derived from the interval the open checkpoint window was started under rather
 * than from the current setting, because lowering the interval would otherwise
 * shrink the tolerance beneath a window that was legitimately wider.
 */
function activeGapToleranceMs(): number {
	return Math.max(pollIntervalMs * 3, MIN_ACTIVE_GAP_TOLERANCE_MS);
}

/** True when a gap is too long to be anything but the host having stopped. */
function isSuspendGap(elapsed: number): boolean {
	return elapsed > activeGapToleranceMs();
}

/** Elapsed time since the last checkpoint, discarding suspended time. */
function elapsedSinceCheckpoint(metrics: ExposureMetrics, now: number): number {
	if (metrics.enabledSince === undefined) {
		return 0;
	}

	const elapsed = now - metrics.enabledSince;
	return elapsed > 0 && !isSuspendGap(elapsed) ? elapsed : 0;
}

/** Return accumulated enabled time, including the currently active interval. */
function enabledDuration(metrics: ExposureMetrics, now = Date.now()): number {
	return metrics.enabledDurationMs + elapsedSinceCheckpoint(metrics, now);
}

/** Persist elapsed enabled time into a bucket without changing whether it is active. */
function checkpointEnabledDuration(metrics: ExposureMetrics, now = Date.now()): void {
	if (metrics.enabledSince === undefined) {
		return;
	}

	// Discarding a gap means the extension was not running across it, so the
	// stretch the dashboard reports starts here rather than spanning it.
	if (isSuspendGap(now - metrics.enabledSince)) {
		activeSince = now;
	}

	metrics.enabledDurationMs += elapsedSinceCheckpoint(metrics, now);
	metrics.enabledSince = now;
}

/** Adopt the shared record at startup so the day's totals survive a reload. */
async function loadSharedDaily(context: vscode.ExtensionContext): Promise<void> {
	try {
		await vscode.workspace.fs.createDirectory(context.globalStorageUri);
	} catch (error) {
		output.warn(`Unable to create the extension storage directory: ${String(error)}`);
	}

	const stored = await readSharedDaily();

	// A checkpoint from an earlier run must not extend into this one: the time
	// between them is time no window was running.
	if (stored !== undefined && stored.date === localDateKey()) {
		sharedDaily = { ...stored, lastCheckpointAt: Date.now() };
	}

	// A window still running an older build rewrites these, so they are cleared
	// on every activation rather than once.
	for (const key of LEGACY_DAILY_KEYS) {
		void context.globalState.update(key, undefined).then(undefined, () => {});
	}
}

/**
 * Refresh the dashboard when the local date changes.
 *
 * The poll loop rolls the daily bucket while approval is active, but nothing
 * runs while it is off, so a hover after midnight would keep reporting
 * yesterday's total until some other event rebuilt the dashboard.
 */
function scheduleDailyRollover(): void {
	if (rolloverTimer !== undefined) {
		clearTimeout(rolloverTimer);
	}

	const now = new Date();
	const midnight = new Date(now);
	midnight.setHours(24, 0, 0, 0);

	// A second past midnight, so the new local date is unambiguous.
	rolloverTimer = setTimeout(() => {
		void flushSharedDaily(true).finally(() => updateStatusBar());
		scheduleDailyRollover();
	}, midnight.getTime() - now.getTime() + 1_000);
}

/** Start or checkpoint enabled-duration tracking when the setting changes. */
function updateEnabledDurationTracking(enabled: boolean): void {
	const now = Date.now();

	if (enabled) {
		sessionMetrics.enabledSince ??= now;

		// Unlike `enabledSince`, this survives duration checkpoints so the
		// dashboard can report when the current active stretch began.
		activeSince ??= now;
		void flushSharedDaily(true);
		return;
	}

	checkpointEnabledDuration(sessionMetrics, now);
	sessionMetrics.enabledSince = undefined;
	activeSince = undefined;

	// Folded even though approval is now off: the interval being closed here is
	// time it was still on, and dropping it would lose up to a flush interval
	// on every toggle.
	void flushSharedDaily(true, true);
}

/** Note that the poll loop ran, so diagnostics can show it is alive. */
function recordPoll(): void {
	const now = Date.now();

	// Fold each interval in as it passes rather than deriving totals from one
	// start timestamp. Checkpointing this often is what lets a suspend gap be
	// recognized and dropped instead of being counted as active time.
	checkpointEnabledDuration(sessionMetrics, now);
	sessionMetrics.lastAttemptAt = now;
	void flushSharedDaily();
}

/** Record a failed automatic command invocation for this window and the day. */
function recordUnsuccessfulAttempt(): void {
	sessionMetrics.unsuccessfulAttempts++;
	pendingDaily.unsuccessfulAttempts++;
	void flushSharedDaily();
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
	// The configured mode decides which command is invoked, so checking any
	// other one would report a missing allowlist command as available.
	const mode = currentMode();
	const command = APPROVE_COMMANDS[mode];
	const all = await vscode.commands.getCommands(true);
	commandAvailable = all.includes(command);
	commandAvailableForMode = mode;

	if (!commandAvailable) {
		output.warn(
			`Command '${command}' is not registered. This extension requires Cursor, not stock VS Code.`,
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

	recordPoll();
	const successful = await approveOnce("poll");

	if (!successful) {
		recordUnsuccessfulAttempt();
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

	// Close the open checkpoint window under the interval that opened it, so a
	// lowered interval cannot retroactively judge that window as a suspend gap.
	checkpointEnabledDuration(sessionMetrics, Date.now());
	pollIntervalMs = interval;

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
	const when = new Date(timestamp);
	const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

	// A stretch running past local midnight would otherwise read as a start
	// time later than the current time.
	if (localDateKey(when) === localDateKey()) {
		return time;
	}

	return `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function formatInterval(intervalMs: number): string {
	return intervalMs % 1000 === 0 ? `${intervalMs / 1000}s` : `${intervalMs} ms`;
}

/**
 * Render approvals against the agent commands that ran, as `16/18`.
 *
 * Both sides are padded to the widest value across the rows so the slashes line
 * up. The padding is a figure space, which is exactly one digit wide and, being
 * outside the HTML whitespace set, is not collapsed the way a plain space in a
 * table cell would be.
 */
function formatApprovalRatios(pairs: Array<readonly [approved: number, run: number]>): string[] {
	const approved = pairs.map(([value]) => value.toLocaleString());
	const run = pairs.map(([, value]) => value.toLocaleString());
	const approvedWidth = Math.max(...approved.map((value) => value.length));
	const runWidth = Math.max(...run.map((value) => value.length));
	const pad = (value: string, width: number) => `${"\u2007".repeat(width - value.length)}${value}`;

	return pairs.map((_, index) => `${pad(approved[index], approvedWidth)}/${pad(run[index], runWidth)} Auto Approved`);
}

/** Format a count with thousands separators and a matching noun. */
function formatCount(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** Escape a dynamic value before embedding it in a Markdown dashboard. */
function escapeMarkdown(value: string): string {
	return value.replace(/([\\`*_[\]<>&])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

/**
 * Build a colored severity pill for the dashboard.
 *
 * The renderer's sanitizer keeps `style` only on `span`, and only accepts
 * `color`, `background-color`, and `border-radius`, in that order, with no
 * whitespace in the declaration, so the value below cannot be reformatted.
 * Padding is not permitted, which is why the label is spaced with non-breaking
 * spaces. The colors come from the status bar's own severity entries, so they
 * stay legible in whichever theme is active.
 */
function statusPill(label: string, severity: "error" | "warning"): string {
	const style = `color:var(--vscode-statusBarItem-${severity}Foreground);`
		+ `background-color:var(--vscode-statusBarItem-${severity}Background);`
		+ "border-radius:3px;";

	return `<span style="${style}">&nbsp;${label}&nbsp;</span>`;
}

/** Build a safe, theme-native dashboard for the status bar hover tooltip. */
function statusBarTooltip(enabled: boolean): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	const now = Date.now();
	// Command URIs take their arguments as an encoded JSON array.
	const settingsQuery = encodeURIComponent(JSON.stringify([SECTION]));

	// Command execution remains opt-in: only the footer links below can run.
	markdown.isTrusted = { enabledCommands: DASHBOARD_COMMANDS };
	markdown.supportHtml = true;
	markdown.baseUri = extensionUri?.with({ path: `${extensionUri.path}/` });

	// Identity and live state share one table so the logo can span both rows.
	// `rowspan` survives the sanitizer, and a `td` is vertically centered by
	// default, so the logo lines up against the pair without needing CSS.
	// Markdown is not parsed inside raw HTML, which is why the emphasis and the
	// mode badge are written as tags rather than as `**` and backticks.
	const logoCell = extensionUri
		? '<td rowspan="2"><img src="./logo512.png" width="32" height="32" align="center" alt="" />&nbsp;&nbsp;</td>'
		: "";

	const interval = timer === undefined
		? ""
		: `&nbsp;&nbsp;every ${formatInterval(config().get<number>("intervalMs", 1000))}`;

	markdown.appendMarkdown(
		`<table><tr>${logoCell}`
			+ "<td><strong>Cursor Approve</strong></td>"
			+ `<td>&nbsp;&nbsp;v${escapeMarkdown(extensionVersion)}</td>`
			+ "</tr><tr>"
			+ `<td>${enabled ? "$(check-all)" : "$(circle-slash)"}&nbsp;<strong>${
				enabled ? "Active" : "Inactive"
			}</strong>&nbsp;·&nbsp;<code>${currentMode()}</code></td>`
			+ `<td>${interval}</td>`
			+ "</tr></table>\n\n",
	);

	// How long the confirmation step has been bypassed, and how much of the work
	// that ran while it was this extension released rather than Cursor
	// auto-running it under its own rules. The ratio carries both numbers, and
	// the gap between them is the part worth seeing.
	const metrics: Array<[string, string, string?]> = [];

	if (enabled && activeSince !== undefined) {
		metrics.push(["Active since", formatClockTime(activeSince)]);
	}

	const [sessionRatio, todayRatio] = formatApprovalRatios([
		[sessionMetrics.commandsApproved, sessionMetrics.commandsRun],
		[dailyCount("commandsApproved", now), dailyCount("commandsRun", now)],
	]);

	metrics.push(["Current Session", formatDuration(enabledDuration(sessionMetrics, now)), sessionRatio]);
	metrics.push(["Total Today", formatDuration(dailyActiveMs(now)), todayRatio]);

	// A table keeps durations and counts each in their own column so they can be
	// compared down the list. Hovers carry no table styling, so the cells render
	// without borders; the sanitizer strips cellpadding, so gutters are spaces.
	markdown.appendMarkdown(
		`<table>${
			metrics
				.map(([label, ...cells]) =>
					`<tr><td>${label}&nbsp;&nbsp;</td>${
						cells
							.map((cell) => `<td>${cell === undefined ? "" : `${cell}&nbsp;&nbsp;`}</td>`)
							.join("")
					}</tr>`
				)
				.join("")
		}</table>\n\n`,
	);

	// Exceptions get their own line only while they apply, so a healthy hover
	// stays short and a real problem cannot hide among rows of zeroes.
	if (commandAvailable === false) {
		markdown.appendMarkdown(`${statusPill("Unavailable", "error")}&nbsp; Cursor approval command\n\n`);
	}

	if (dailyCount("unsuccessfulAttempts", now) > 0) {
		markdown.appendMarkdown(
			`${statusPill("Failed", "warning")}&nbsp; ${
				formatCount(dailyCount("unsuccessfulAttempts", now), "unsuccessful attempt")
			} today\n\n`,
		);
	}

	if (config().get<boolean>("onlyWhenFocused", false)) {
		markdown.appendMarkdown("$(eye) Approving only while this window is focused\n\n");
	}

	// Allowlist mode outlives the session, so it deserves to be called out.
	if (currentMode() === "allowlist") {
		markdown.appendMarkdown(
			`${statusPill("Allowlist", "warning")}&nbsp; Approved commands are remembered\n\n`,
		);
	}

	markdown.appendMarkdown("---\n\n");

	// The toggle link is worded for either state. Clicking it leaves the hover
	// open, and an open hover keeps the DOM it was rendered with: reassigning
	// `StatusBarItem.tooltip` replaces the value for the next hover but cannot
	// re-render the current one, and nothing in the API dismisses it. A
	// state-specific label such as "Turn Off" would therefore contradict itself
	// until the user moves away and hovers again.
	markdown.appendMarkdown(
		'[$(symbol-boolean)&nbsp;Toggle On/Off](command:cursorApprove.toggle "Turn automatic approval on or off")'
			+ '&nbsp; · &nbsp;[$(output)&nbsp;Diagnostics](command:cursorApprove.diagnose "Open the Cursor Approve output channel")'
			+ `&nbsp; · &nbsp;[$(gear)&nbsp;Settings](command:workbench.action.openSettings?${settingsQuery} "Open Cursor Approve settings")`,
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

	// A stale record renders as zeroes for the new day rather than yesterday's
	// totals, so rendering never has to wait for a merge to be correct.
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

	// Each mode invokes a different command, so a mode change invalidates the
	// cached availability that the dashboard and diagnostics report.
	if (commandAvailableForMode !== currentMode()) {
		void checkCommandAvailability().then(() => updateStatusBar());
	}
}

/** Bucket how long after an invocation an agent command started. */
function recordLatency(sinceInvocation: number | undefined): void {
	if (sinceInvocation === undefined) {
		return;
	}

	const bucket = PROBE_LATENCY_BUCKETS_MS.findIndex((bound) => sinceInvocation <= bound);
	probeMetrics.latencyBuckets[bucket === -1 ? PROBE_LATENCY_BUCKETS_MS.length : bucket]++;
}

/** True for the terminals Cursor's agent runs its commands in. */
function isAgentTerminal(terminal: vscode.Terminal): boolean {
	return AGENT_TERMINAL_PREFIXES.some((prefix) => terminal.name.startsWith(prefix));
}

/**
 * Count the commands Cursor's agent actually runs.
 *
 * These executions do reach the extension host, so the dashboard can report
 * that work is getting through. It still cannot report approvals granted: the
 * same command would run whether this extension approved it, Cursor auto-ran
 * it from its own allowlist, or the user clicked Run. The probe counters
 * alongside it measure how tightly these follow an invocation, which is what
 * would have to hold before any stronger claim could be made.
 */
function registerAgentCommandWatcher(context: vscode.ExtensionContext): void {
	// Terminals that predate activation never raise the open event, so seed the
	// counts from the ones already present to keep the baseline honest.
	probeMetrics.terminalsOpened = vscode.window.terminals.length;
	probeMetrics.shellIntegrationsActivated = vscode.window.terminals.filter(
		(terminal) => terminal.shellIntegration !== undefined,
	).length;

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
			vscode.window.onDidStartTerminalShellExecution(({ terminal }) => {
				const sinceInvocation = lastInvocationAt === undefined ? undefined : Date.now() - lastInvocationAt;

				probeMetrics.executionsStarted++;

				// The command line is never read: this event covers every execution
				// the host exposes, including commands the user typed, and their
				// arguments routinely carry tokens. The terminal name is all that is
				// needed to tell an agent terminal from a personal shell.
				if (probeMetrics.executionsByTerminal.size < PROBE_TERMINAL_NAME_LIMIT) {
					const name = terminal.name;
					probeMetrics.executionsByTerminal.set(name, (probeMetrics.executionsByTerminal.get(name) ?? 0) + 1);
				}

				if (!isAgentTerminal(terminal)) {
					return;
				}

				probeMetrics.agentExecutions++;
				recordLatency(sinceInvocation);

				// Only while approval is active: otherwise this counts commands the
				// user approved by hand with the extension switched off.
				if (isEnabled()) {
					const approved = sinceInvocation !== undefined && sinceInvocation <= APPROVAL_ATTRIBUTION_MS;

					sessionMetrics.commandsRun++;
					pendingDaily.commandsRun++;

					if (approved) {
						sessionMetrics.commandsApproved++;
						pendingDaily.commandsApproved++;
					}

					void flushSharedDaily();
				}

				output.debug(
					`probe: agent command in '${terminal.name}' ${sinceInvocation ?? "?"}ms after last invocation`,
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
	await loadSharedDaily(context);

	context.subscriptions.push(output);
	ensureStatusBarItem();
	registerAgentCommandWatcher(context);

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
			await flushSharedDaily(true);
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
			output.info(`sessionCommandsRun ${sessionMetrics.commandsRun}`);
			output.info(`sessionApproved    ${sessionMetrics.commandsApproved}`);
			output.info(`sessionUnsuccessful ${sessionMetrics.unsuccessfulAttempts}`);
			output.info(`sessionLastPoll    ${sessionMetrics.lastAttemptAt ?? "none"}`);
			output.info("--- Shared across windows ---");
			output.info(`today              ${sharedDaily.date}`);
			output.info(`todayEnabledMs     ${dailyActiveMs()}`);
			output.info(`todayCommandsRun   ${dailyCount("commandsRun")}`);
			output.info(`todayApproved      ${dailyCount("commandsApproved")}`);
			output.info(`todayUnsuccessful  ${dailyCount("unsuccessfulAttempts")}`);
			output.info(`sharedCheckpoint   ${sharedDaily.lastCheckpointAt}`);
			output.info(`sharedFile         ${sharedDailyUri()?.fsPath ?? "unavailable"}`);
			output.info(`consecutiveUnsuccessful ${consecutiveErrorCount}`);
			output.info(`lastUnsuccessful   ${lastError ?? "none"}`);
			output.info("--- Approval probe (experimental) ---");
			output.info(`terminalsOpened    ${probeMetrics.terminalsOpened}`);
			output.info(`shellIntegrations  ${probeMetrics.shellIntegrationsActivated}`);
			output.info(`executionsStarted  ${probeMetrics.executionsStarted}`);
			output.info(`agentExecutions    ${probeMetrics.agentExecutions}`);
			for (const [name, count] of probeMetrics.executionsByTerminal) {
				output.info(`  terminal '${name}' ${count}`);
			}
			output.info("Delay from the last invocation to an agent command starting:");
			probeMetrics.latencyBuckets.forEach((count, index) => {
				const bound = PROBE_LATENCY_BUCKETS_MS[index];
				output.info(`  ${bound === undefined ? "slower" : `<=${bound}ms`} ${count}`);
			});
			output.info("Cursor's approval command reports nothing, so approvals are attributed by");
			output.info(`timing: an agent command starting within ${APPROVAL_ATTRIBUTION_MS}ms of an invocation was`);
			output.info("released by it. Commands Cursor auto-ran from its own allowlist or sandbox");
			output.info("needed no approval and land uniformly across the poll interval instead.");
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
		{
			dispose: () => {
				if (rolloverTimer !== undefined) {
					clearTimeout(rolloverTimer);
					rolloverTimer = undefined;
				}
			},
		},
	);

	scheduleDailyRollover();
	applyConfiguration();
}

/** Tear down polling and save the current enabled-duration checkpoint. */
export async function deactivate(): Promise<void> {
	stopPolling();

	if (rolloverTimer !== undefined) {
		clearTimeout(rolloverTimer);
		rolloverTimer = undefined;
	}

	// Merge before the checkpoint is cleared, so this window's last interval and
	// any unmerged counts reach the shared record. `flushSharedDaily` already
	// logs its own failures rather than rejecting.
	await flushSharedDaily(true);

	checkpointEnabledDuration(sessionMetrics, Date.now());
	sessionMetrics.enabledSince = undefined;
	activeSince = undefined;
}
