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

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

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
 * What this window has seen during the current active stretch.
 *
 * The stretch is the span the dashboard reports as "Active since": it starts
 * when approval is switched on, restarts when the machine wakes from a gap long
 * enough to prove nothing was running, and restarts again at local midnight so
 * the figures never straddle two days. Tying the counts to the same span the
 * clock time describes is what keeps the row self-consistent.
 */
interface WindowMetrics {
	unsuccessfulAttempts: number;
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

/** Metrics for the current active stretch in this window. */
let windowMetrics: WindowMetrics = createWindowMetrics();

/** Time of the last poll, used to recognize a gap the machine slept through. */
let lastPollAt: number | undefined;

/** The shared day's totals as of this window's last merge. */
let sharedDaily: SharedDailyRecord = createSharedDailyRecord();

/** Counts awaiting their next merge into the shared file. */
let pendingDaily: PendingDailyDelta = createPendingDailyDelta();

/** Timestamp of this window's last successful merge. */
let lastSharedFlushAt = 0;

/** The merge currently running, since each one is a read-modify-write. */
let sharedFlushInFlight: Promise<void> | undefined;

/** The re-read currently running, for windows that are not polling. */
let sharedReloadInFlight: Promise<void> | undefined;

/** When the shared record was last re-read, to rate-limit the reload. */
let lastSharedReloadAt = 0;

/** Start of the current uninterrupted active stretch, for "Active since". */
let activeSince: number | undefined;

/** Enabled state the last `applyConfiguration` acted on, to spot a transition. */
let lastAppliedEnabled: boolean | undefined;

/** `setTimeout` handle for the next local-midnight dashboard refresh. */
let rolloverTimer: ReturnType<typeof setTimeout> | undefined;

/** Rendered tooltip currently assigned, so it is only reassigned when it changes. */
let lastTooltipValue: string | undefined;

/** When the approval command was last invoked, used to correlate probe events. */
let lastInvocationAt: number | undefined;

/** Short-lived webview used to render a dashboard PNG for the clipboard. */
let copyDashboardPanel: vscode.WebviewPanel | undefined;

/** Cached HTML shell for the copy webview, read once at activation. */
let copyDashboardHtmlTemplate: string | undefined;

/** Logo embedded as a data URI so the webview never fetches logo512.png. */
let exportLogoDataUri: string | undefined;

/** Prevents overlapping copy runs from racing the same webview. */
let copyDashboardInFlight = false;

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

function createWindowMetrics(): WindowMetrics {
	return {
		unsuccessfulAttempts: 0,
		lastAttemptAt: undefined,
		commandsRun: 0,
		commandsApproved: 0,
	};
}

/** Local midnight that opened the day containing `now`. */
function startOfLocalDay(now = Date.now()): number {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	return midnight.getTime();
}

/** Begin a fresh active stretch, discarding what the previous one measured. */
function startActiveStretch(now: number): void {
	activeSince = now;
	windowMetrics = createWindowMetrics();
}

/**
 * Keep the active stretch honest on every poll.
 *
 * A gap far longer than the poll interval means the machine was suspended, so
 * the stretch restarts rather than claiming to span it. A stretch is also cut
 * at local midnight, so the window figures never describe part of yesterday
 * while the day's figures beside them start at 00:00.
 */
function updateActiveStretch(now: number): void {
	if (activeSince === undefined) {
		startActiveStretch(now);
	} else if (lastPollAt !== undefined && isSuspendGap(now - lastPollAt)) {
		startActiveStretch(now);
	} else if (activeSince < startOfLocalDay(now)) {
		startActiveStretch(startOfLocalDay(now));
	}

	lastPollAt = now;
}

/**
 * How long the current stretch has run, measured from what "Active since" shows.
 *
 * A suspend is discarded when the next poll notices it, but the dashboard can
 * be rendered before that poll arrives, so the same gap is excluded here too.
 * Otherwise waking the machine would show a stretch containing the whole sleep
 * for up to one poll interval, beside a day total that had already refused to
 * count it.
 */
function activeStretchMs(now = Date.now()): number {
	if (activeSince === undefined) {
		return 0;
	}

	const end = lastPollAt !== undefined && isSuspendGap(now - lastPollAt) ? lastPollAt : now;
	return Math.max(0, end - activeSince);
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
 * Re-reading immediately before writing is what lets concurrent windows
 * accumulate instead of overwriting each other wholesale, and the rename keeps
 * any reader from seeing a half-written file. It is not a cross-process lock,
 * though: two windows whose read-modify-write cycles overlap still resolve to
 * whichever renamed last, costing the other's counts for that cycle. Each
 * window merges at most once a minute and the cycle itself takes milliseconds,
 * so the exposure is small and bounded to a few commands in a metric. Active
 * time is unaffected either way, since it is folded from the shared checkpoint
 * rather than summed per window.
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

/**
 * Re-read the shared record when another window may have moved it on.
 *
 * Only for windows that are not polling: a merge already re-reads, so an active
 * window is current by construction. Rate-limited to the flush interval and
 * re-renders only when the totals actually changed, so a hover is not redrawn
 * underneath the pointer.
 */
async function reloadSharedDailyIfStale(): Promise<void> {
	if (sharedReloadInFlight !== undefined || Date.now() - lastSharedReloadAt < SHARED_FLUSH_INTERVAL_MS) {
		return;
	}

	lastSharedReloadAt = Date.now();
	sharedReloadInFlight = (async () => {
		try {
			const stored = await readSharedDaily();
			if (stored === undefined || stored.date !== sharedDaily.date) {
				return;
			}

			const changed = stored.activeMs !== sharedDaily.activeMs
				|| stored.commandsRun !== sharedDaily.commandsRun
				|| stored.commandsApproved !== sharedDaily.commandsApproved
				|| stored.unsuccessfulAttempts !== sharedDaily.unsuccessfulAttempts;

			if (changed) {
				sharedDaily = stored;
				updateStatusBar();
			}
		} catch (error) {
			output.debug(`Unable to reload the shared daily metrics: ${String(error)}`);
		} finally {
			sharedReloadInFlight = undefined;
		}
	})();

	await sharedReloadInFlight;
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

		// Persist that advance before anything folds. Merging re-reads the file
		// rather than trusting this copy, so leaving the old timestamp on disk
		// meant the first merge after a quick reload folded the whole shutdown
		// gap as active time.
		await flushSharedDaily(true, false);
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
		// The poll loop cuts the stretch at midnight, but the redraw below runs
		// first, and a hover taken before the next poll would otherwise show a
		// window spanning yesterday beside a day total that had already reset.
		const rolledAt = Date.now();
		if (activeSince !== undefined && activeSince < startOfLocalDay(rolledAt)) {
			startActiveStretch(startOfLocalDay(rolledAt));
		}

		void flushSharedDaily(true).finally(() => updateStatusBar());
		scheduleDailyRollover();
	}, midnight.getTime() - now.getTime() + 1_000);
}

/** Open or close the active stretch when the setting changes. */
function updateActiveStretchForSetting(enabled: boolean): void {
	if (enabled) {
		startActiveStretch(Date.now());
		lastPollAt = undefined;
		void flushSharedDaily(true);
		return;
	}

	activeSince = undefined;
	lastPollAt = undefined;

	// Folded even though approval is now off: the interval being closed here is
	// time it was still on, and dropping it would lose up to a flush interval
	// on every toggle.
	void flushSharedDaily(true, true);
}

/** Note that the poll loop ran, so the stretch and the day stay current. */
function recordPoll(): void {
	const now = Date.now();
	updateActiveStretch(now);
	windowMetrics.lastAttemptAt = now;
	void flushSharedDaily();
}

/** Record a failed automatic command invocation for this window and the day. */
function recordUnsuccessfulAttempt(): void {
	windowMetrics.unsuccessfulAttempts++;
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

	// Only the poll loop feeds attribution. A command the user released through
	// Approve Pending Tool Call Once was not approved automatically, so counting
	// it would contradict the row it lands in.
	lastInvocationAt = reason === "poll" ? Date.now() : undefined;

	try {
		await vscode.commands.executeCommand(command);
		consecutiveErrorCount = 0;
		output.debug(`Invoked ${command} (${reason})`);
		return true;
	} catch (error) {
		// Nothing was released, so the timestamp must not survive to attribute
		// an agent command that happens to start within the attribution window.
		lastInvocationAt = undefined;
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
		// The loop is alive even though this tick approved nothing, so record
		// that. Without it, working in another application for longer than the
		// tolerance was indistinguishable from a suspend, and returning to the
		// window threw away the stretch and its counts.
		lastPollAt = Date.now();
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

	// Restart the checkpoint window at the change rather than clearing it. The
	// gap being replaced is still not judged against the new tolerance, but
	// suspend detection stays armed: leaving this undefined meant a machine that
	// slept before the next poll had nothing to measure the gap from, and the
	// sleep counted as active until that poll arrived.
	lastPollAt = Date.now();
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
	"cursorApprove.copyDashboard",
	"workbench.action.openSettings",
] as const;

/** Timeout for the clipboard webview to render and copy. */
const DASHBOARD_COPY_TIMEOUT_MS = 10_000;

/** Plain-text dashboard snapshot passed to the clipboard webview. */
interface DashboardSnapshot {
	version: string;
	enabled: boolean;
	mode: string;
	interval: string | undefined;
	logoUri: string | undefined;
	activeSince: string | undefined;
	window: { duration: string; approved: number; run: number } | undefined;
	today: { duration: string; approved: number; run: number };
	alerts: Array<
		| { kind: "pill"; label: string; severity: "error" | "warning"; detail: string }
		| { kind: "line"; text: string }
	>;
}

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
function formatDurationPlain(durationMs: number): string {
	const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}

	return totalMinutes === 0 ? "<1m" : `${totalMinutes}m`;
}

function formatDuration(durationMs: number): string {
	// Entity rather than "<" because the dashboard renders with HTML support.
	return formatDurationPlain(durationMs).replace("<", "&lt;");
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
 * Render one metrics row of the dashboard.
 *
 * The ratio is split across three cells, the numerator right-aligned against
 * the slash and the denominator left-aligned after it, so the slashes and the
 * labels that follow line up between rows. Padding the text cannot do this: the
 * hover renders in the UI font, whose digits are proportional, so an equal
 * count of digits is still an unequal width.
 */
function metricRow(label: string, duration: string, approved: number, run: number): string {
	return `<tr><td>${label}&nbsp;&nbsp;</td><td>${duration}&nbsp;&nbsp;&nbsp;</td>`
		+ `<td align="right">${approved.toLocaleString()}</td><td>/</td>`
		+ `<td>${run.toLocaleString()}&nbsp;&nbsp;</td><td>Auto Approved</td></tr>`;
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
/** Read the copy webview shell and logo once so copies do not pay disk I/O. */
async function loadCopyDashboardResources(context: vscode.ExtensionContext): Promise<void> {
	if (copyDashboardHtmlTemplate === undefined) {
		const htmlUri = vscode.Uri.joinPath(context.extensionUri, "media", "copy-dashboard.html");
		copyDashboardHtmlTemplate = new TextDecoder().decode(await vscode.workspace.fs.readFile(htmlUri));
	}

	if (exportLogoDataUri === undefined) {
		const logoUri = vscode.Uri.joinPath(context.extensionUri, "logo512.png");
		const bytes = await vscode.workspace.fs.readFile(logoUri);
		exportLogoDataUri = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
	}
}

/** Collect the dashboard state the clipboard webview renders into a PNG. */
function buildDashboardSnapshot(logoUri: string | undefined): DashboardSnapshot {
	const now = Date.now();
	const enabled = isEnabled();
	const alerts: DashboardSnapshot["alerts"] = [];

	if (commandAvailable === false) {
		alerts.push({ kind: "pill", label: "Unavailable", severity: "error", detail: "Cursor approval command" });
	}

	if (dailyCount("unsuccessfulAttempts", now) > 0) {
		alerts.push({
			kind: "pill",
			label: "Failed",
			severity: "warning",
			detail: `${formatCount(dailyCount("unsuccessfulAttempts", now), "unsuccessful attempt")} today`,
		});
	}

	if (config().get<boolean>("onlyWhenFocused", false)) {
		alerts.push({ kind: "line", text: "Approving only while this window is focused" });
	}

	if (currentMode() === "allowlist") {
		alerts.push({
			kind: "pill",
			label: "Allowlist",
			severity: "warning",
			detail: "Approved commands are remembered",
		});
	}

	return {
		version: extensionVersion,
		enabled,
		mode: currentMode(),
		interval: timer === undefined
			? undefined
			: formatInterval(config().get<number>("intervalMs", 1000)),
		logoUri,
		activeSince: enabled && activeSince !== undefined ? formatClockTime(activeSince) : undefined,
		window: enabled && activeSince !== undefined
			? {
				duration: formatDurationPlain(activeStretchMs(now)),
				approved: windowMetrics.commandsApproved,
				run: windowMetrics.commandsRun,
			}
			: undefined,
		today: {
			duration: formatDurationPlain(dailyActiveMs(now)),
			approved: dailyCount("commandsApproved", now),
			run: dailyCount("commandsRun", now),
		},
		alerts,
	};
}

/** Wait for one webview message of the given type. */
function waitForCopyDashboardMessage(
	panel: vscode.WebviewPanel,
	type: string,
	timeoutMs: number,
): Promise<{ message?: string; dataUrl?: string }> {
	return new Promise((resolve, reject) => {
		const subscription = panel.webview.onDidReceiveMessage((message: {
			type?: string;
			message?: string;
			dataUrl?: string;
		}) => {
			if (message.type === type) {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(message);
			}
		});

		const timeout = setTimeout(() => {
			subscription.dispose();
			reject(new Error("Timed out copying dashboard"));
		}, timeoutMs);
	});
}

/** Create a copy webview shell and wait until its render script is ready. */
async function createCopyDashboardPanel(context: vscode.ExtensionContext): Promise<vscode.WebviewPanel> {
	await loadCopyDashboardResources(context);

	const panel = vscode.window.createWebviewPanel(
		"cursorApproveDashboardExport",
		"Copy Dashboard",
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
		},
	);
	copyDashboardPanel = panel;

	panel.onDidDispose(() => {
		if (copyDashboardPanel === panel) {
			copyDashboardPanel = undefined;
		}
	});

	const readyWithoutReveal = waitForCopyDashboardMessage(panel, "ready", 400);
	panel.webview.html = copyDashboardHtmlTemplate!
		.replaceAll("{{cspSource}}", panel.webview.cspSource);

	try {
		await readyWithoutReveal;
	} catch {
		// Some hosts need one visible frame before webview scripts run.
		const readyAfterReveal = waitForCopyDashboardMessage(panel, "ready", DASHBOARD_COPY_TIMEOUT_MS);
		panel.reveal(undefined, true);
		await readyAfterReveal;
	}

	return panel;
}

/** Ask the copy webview to render a snapshot and return PNG bytes. */
async function renderCopyDashboardToPng(panel: vscode.WebviewPanel, snapshotB64: string): Promise<Buffer> {
	const message = await new Promise<{ message?: string; dataUrl?: string }>((resolve, reject) => {
		const subscription = panel.webview.onDidReceiveMessage((incoming: {
			type?: string;
			message?: string;
			dataUrl?: string;
		}) => {
			if (incoming.type === "done") {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(incoming);
				return;
			}

			if (incoming.type === "error") {
				clearTimeout(timeout);
				subscription.dispose();
				reject(new Error(incoming.message ?? "Unable to copy dashboard"));
			}
		});

		const timeout = setTimeout(() => {
			subscription.dispose();
			reject(new Error("Timed out copying dashboard"));
		}, DASHBOARD_COPY_TIMEOUT_MS);

		panel.webview.postMessage({ type: "render", snapshotB64 });
	});

	if (typeof message.dataUrl !== "string") {
		throw new Error("Unable to copy dashboard");
	}

	const marker = "data:image/png;base64,";
	const base64 = message.dataUrl.startsWith(marker)
		? message.dataUrl.slice(marker.length)
		: message.dataUrl;
	return Buffer.from(base64, "base64");
}

/**
 * Copy a PNG of the dashboard through a short-lived webview.
 *
 * VS Code's clipboard API is text-only, so a webview draws the dashboard and
 * posts PNG bytes back to the extension host.
 */
async function copyDashboardToClipboard(context: vscode.ExtensionContext): Promise<void> {
	if (copyDashboardInFlight) {
		return;
	}

	copyDashboardInFlight = true;

	let panel: vscode.WebviewPanel | undefined;

	try {
		const resourcesPromise = loadCopyDashboardResources(context);
		const flushPromise = flushSharedDaily(true);

		await Promise.all([resourcesPromise, flushPromise]);

		panel = await createCopyDashboardPanel(context);

		const snapshotB64 = Buffer.from(JSON.stringify(buildDashboardSnapshot(exportLogoDataUri))).toString("base64");
		const png = await renderCopyDashboardToPng(panel, snapshotB64);

		// Close the tab as soon as the PNG is ready; clipboard write needs no UI.
		panel.dispose();
		panel = undefined;

		await writePngToClipboard(png);
	} finally {
		panel?.dispose();
		copyDashboardInFlight = false;
	}
}

/** Copy PNG bytes through the platform clipboard, outside the webview. */
async function writePngToClipboard(png: Buffer): Promise<void> {
	// A name derived from the clock is predictable, and writing to it would
	// follow a symlink another local process had left in its place, which turns
	// copying an image into overwriting a file of the attacker's choosing.
	// `mkdtemp` gives a fresh directory with a random name and owner-only
	// permissions, and `wx` refuses to write if anything is already there.
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-approve-"));
	const temporary = path.join(directory, "dashboard.png");

	try {
		await fs.writeFile(temporary, png, { flag: "wx" });

		if (process.platform === "darwin") {
			// The path is passed as an argument and read from `argv` rather than
			// interpolated into the script. `os.tmpdir()` follows TMPDIR, so a
			// path holding a quote or a newline could otherwise close the string
			// literal and have the rest of it run as AppleScript.
			await execFileAsync("osascript", [
				"-e",
				"on run argv\nset the clipboard to "
				+ "(read (POSIX file (item 1 of argv)) as «class PNGf»)\nend run",
				temporary,
			]);
			return;
		}

		if (process.platform === "win32") {
			const script = "Add-Type -AssemblyName System.Windows.Forms; "
				+ "$image = [System.Drawing.Image]::FromFile($env:CURSOR_APPROVE_PNG); "
				+ "[System.Windows.Forms.Clipboard]::SetImage($image); "
				+ "$image.Dispose()";
			// `Clipboard` requires a single-threaded apartment. Windows
			// PowerShell has defaulted to STA since 3.0, so this is explicit
			// rather than corrective, and costs nothing if it is redundant.
			await execFileAsync(
				"powershell.exe",
				["-NoProfile", "-Sta", "-Command", script],
				{ env: { ...process.env, CURSOR_APPROVE_PNG: temporary } },
			);
			return;
		}

		await writePngToLinuxClipboard(temporary);
	} finally {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Put the PNG on a Linux clipboard, trying the tool the session provides.
 *
 * Neither helper ships with a desktop, and which one works depends on the
 * display server, so both are attempted before giving up. The error names them
 * rather than reporting the last failure, since the fix is to install one.
 */
async function writePngToLinuxClipboard(file: string): Promise<void> {
	try {
		// wl-copy takes the image on stdin rather than as a path, so the file is
		// handed over as the child's stdin. Never compose a shell command for
		// this: the path comes from `os.tmpdir()`, so it is only as trustworthy
		// as TMPDIR, and a redirect would make its contents executable.
		const handle = await fs.open(file, "r");

		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn("wl-copy", ["--type", "image/png"], {
					stdio: [handle.fd, "ignore", "ignore"],
				});

				child.once("error", reject);
				child.once("exit", (code) => {
					// wl-copy forks to serve the selection, so the process being
					// waited on here is the one that finished reading.
					if (code === 0) {
						resolve();
					} else {
						reject(new Error(`wl-copy exited with ${String(code)}`));
					}
				});
			});

			return;
		} finally {
			await handle.close();
		}
	} catch (error) {
		output.debug(`wl-copy unavailable, trying xclip: ${String(error)}`);
	}

	try {
		await execFileAsync("xclip", ["-selection", "clipboard", "-target", "image/png", "-i", file]);
	} catch (error) {
		output.debug(`xclip unavailable: ${String(error)}`);
		throw new Error("copying an image needs wl-copy or xclip on Linux; neither could be run");
	}
}

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
	//
	// Hovers carry no table styling, so the cells render without borders; the
	// sanitizer strips cellpadding, so gutters are spaces.
	const rows: string[] = [];

	// The window row measures exactly the span "Active since" names, so the two
	// always agree; without a stretch there is nothing for it to describe.
	if (enabled && activeSince !== undefined) {
		// Spans the remaining columns so a wide clock time cannot stretch the
		// column the durations are compared in.
		rows.push(`<tr><td>Active since&nbsp;&nbsp;</td><td colspan="5">${formatClockTime(activeSince)}</td></tr>`);
		rows.push(metricRow(
			"Current Window",
			formatDuration(activeStretchMs(now)),
			windowMetrics.commandsApproved,
			windowMetrics.commandsRun,
		));
	}

	rows.push(metricRow(
		"Total Today",
		formatDuration(dailyActiveMs(now)),
		dailyCount("commandsApproved", now),
		dailyCount("commandsRun", now),
	));

	markdown.appendMarkdown(`<table>${rows.join("")}</table>\n\n`);

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
	// Markdown is not parsed inside raw HTML, so the footer stays plain Markdown.
	// A table was tried for a right-aligned camera icon, but it left the links as
	// literal text. The camera sits last on the row instead.
	markdown.appendMarkdown(
		'[$(symbol-boolean)&nbsp;Toggle On/Off](command:cursorApprove.toggle "Turn automatic approval on or off")'
			+ '&nbsp; · &nbsp;[$(output)&nbsp;Diagnostics](command:cursorApprove.diagnose "Open the Cursor Approve output channel")'
			+ `&nbsp; · &nbsp;[$(gear)&nbsp;Settings](command:workbench.action.openSettings?${settingsQuery} "Open Cursor Approve settings")`
			+ '&nbsp; · &nbsp;[&nbsp;&nbsp;$(device-camera)&nbsp;&nbsp;](command:cursorApprove.copyDashboard "Copy dashboard image")',
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

	// While approval is off this window never polls, so nothing would reload the
	// shared record and the day's totals would sit at whatever they were when it
	// was switched off, even as another window kept adding to them.
	if (!isEnabled()) {
		void reloadSharedDailyIfStale();
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

	// Only a change of the enabled state opens or closes a stretch. This runs
	// for every `cursorApprove.*` key, and starting a stretch discards the
	// window's duration and counts, so editing the interval or a color would
	// otherwise reset the row the user was watching.
	if (enabled !== lastAppliedEnabled) {
		lastAppliedEnabled = enabled;
		updateActiveStretchForSetting(enabled);
	}

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

					windowMetrics.commandsRun++;
					pendingDaily.commandsRun++;

					if (approved) {
						windowMetrics.commandsApproved++;
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
	void loadCopyDashboardResources(context);

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
		vscode.commands.registerCommand("cursorApprove.copyDashboard", async () => {
			const copying = vscode.window.setStatusBarMessage("Cursor Approve: copying dashboard...", 15_000);

			try {
				await copyDashboardToClipboard(context);
				copying.dispose();
				void vscode.window.setStatusBarMessage("Cursor Approve: dashboard copied to clipboard", 2000);
			} catch (error) {
				copying.dispose();
				const message = error instanceof Error ? error.message : String(error);
				output.warn(`Unable to copy dashboard: ${message}`);
				void vscode.window.showErrorMessage(`Cursor Approve: ${message}`);
			}
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
			output.info(`windowActiveMs     ${activeStretchMs()}`);
			output.info(`windowCommandsRun  ${windowMetrics.commandsRun}`);
			output.info(`windowApproved     ${windowMetrics.commandsApproved}`);
			output.info(`windowUnsuccessful ${windowMetrics.unsuccessfulAttempts}`);
			output.info(`windowLastPoll     ${windowMetrics.lastAttemptAt ?? "none"}`);
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

	// Merge before the stretch is cleared, so this window's last interval and
	// any unmerged counts reach the shared record. `flushSharedDaily` already
	// logs its own failures rather than rejecting.
	await flushSharedDaily(true);

	copyDashboardPanel?.dispose();
	copyDashboardPanel = undefined;

	activeSince = undefined;
	lastPollAt = undefined;
}
