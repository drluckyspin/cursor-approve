// -----------------------------------------------------------------------------------------------------------
// README screenshot capture for `make screenshots`
//
// Regenerates docs/dashboard.png, docs/dashboard-copy.png, and docs/auto-approve.gif from the extension as it
// is built now, so the README never shows an older version or an older dashboard layout.
//
// The installed Cursor runs as a throwaway, signed-out instance with its own profile, extensions folder, and
// logs under a temporary directory. Cursor Approve is loaded as a development extension next to
// scripts/screenshots/fixture, which takes over Cursor's approval commands and writes the renderer-log lines
// Cursor would, so the approval counts are computed by the real code path. Playwright drives the instance
// over Chromium's DevTools protocol and captures from inside the renderer.
//
// Nothing here captures the screen or sends OS-level input: macOS `screencapture` and synthetic system events
// are off limits on this machine's endpoint protection, and a throwaway instance needs neither. The copy PNG
// is taken from the extension's own Copy Dashboard Image path, with the platform clipboard tool replaced on
// this instance's PATH by a stand-in that keeps the file, so the user's clipboard is never touched.
//
// Environment:
//   THEME         Color theme label. Defaults to "City Fog", searched for in Cursor's and VS Code's extension
//                 folders; falls back to Default Dark Modern when it is not installed.
//   CURSOR_APP    Cursor's executable. Defaults to /Applications/Cursor.app/Contents/MacOS/Cursor.
//   OUTPUT_DIR    Where the images are written. Defaults to docs/.
//   KEEP_PROFILE  "true" keeps the temporary profile, logs, and frames for inspection.
// -----------------------------------------------------------------------------------------------------------
// @ts-check

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";

const execFileAsync = promisify(execFile);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(REPO, "scripts", "screenshots", "fixture");
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(REPO, "docs"));
const THEME = process.env.THEME || "City Fog";
const FALLBACK_THEME = "Default Dark Modern";
const CURSOR_APP = process.env.CURSOR_APP || "/Applications/Cursor.app/Contents/MacOS/Cursor";
const KEEP_PROFILE = process.env.KEEP_PROFILE === "true";

const EXTENSION_ID = "drluckyspin.cursor-approve";
const STATUS_ITEM = `[id="${EXTENSION_ID}"]`;

/** Content size of the Cursor window, in CSS pixels. Captures are taken at twice this. */
const WINDOW = { width: 1280, height: 800 };

/** Requests the fixture makes once approval is on; the Current Window row reports them. */
const WINDOW_APPROVALS = 3;

/**
 * Illustrative earlier activity for Total Today, seeded into the shared daily file before launch. Without it
 * the two rows would read the same, and the screenshot could not show that the day spans other windows.
 */
const SEEDED_TODAY = { activeMs: (2 * 60 + 14) * 60_000, approvals: 46 };

/**
 * Region the tour GIF shows, measured from the window's bottom-right corner: the status bar item and the
 * dashboard that opens above it. The capture fails rather than crop the dashboard if it outgrows this.
 */
const GIF_REGION = { width: 560, height: 212 };

/** Frame time while the pointer glides or a click ring expands, and the number of frames a glide takes. */
const GLIDE_FRAME_MS = 40;
const GLIDE_FRAMES = 12;

/** How often the tour samples the window while it waits on the extension. */
const WATCH_INTERVAL_MS = 80;

/**
 * Longest the GIF holds one image while waiting on the extension. Approvals land about two seconds apart, and
 * replaying every idle poll would make the tour drag; this shortens the gaps without skipping any change.
 */
const WATCH_HOLD_CAP_MS = 700;

/**
 * Fresh instances to try before giving up. Now and then an instance stops showing the dashboard on hover, and
 * moving the pointer off and back does not bring it back; a new instance does not inherit the problem.
 */
const ATTEMPTS = 3;

/** The images the tour writes, staged in each attempt's profile and copied out only when all of them exist. */
const OUTPUTS = ["auto-approve.gif", "dashboard.png", "dashboard-copy.png"];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
	console.log(message);
}

/** A path relative to the repository when it is inside it, for progress lines. */
function display(file) {
	const relative = path.relative(REPO, file);
	return relative.startsWith("..") ? file : relative;
}

/** Wait for a condition, failing with `description` if it is not met in time. */
async function waitFor(description, check, timeoutMs = 30_000, intervalMs = 200) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${description}`);
		}
		await delay(intervalMs);
	}
}

/** Same YYYY-MM-DD local key the extension files the day's totals under. */
function localDateKey(now = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The shared-record version, read from source so a bump cannot silently zero the seeded approvals. */
async function sharedDailyVersion() {
	const source = await fs.readFile(path.join(REPO, "src", "extension.ts"), "utf8");
	const match = /const SHARED_DAILY_VERSION = (\d+);/.exec(source);
	if (!match) {
		throw new Error("SHARED_DAILY_VERSION not found in src/extension.ts");
	}
	return Number(match[1]);
}

/** Find an installed extension folder that contributes a color theme with this label. */
async function findThemeExtension(label) {
	const roots = [
		path.join(os.homedir(), ".cursor", "extensions"),
		path.join(os.homedir(), ".vscode", "extensions"),
		// The themes built into Cursor, beside its executable in the macOS app bundle.
		path.join(path.dirname(CURSOR_APP), "..", "Resources", "app", "extensions"),
	];

	for (const root of roots) {
		let entries;
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const folder = path.join(root, entry.name);
			try {
				const manifest = JSON.parse(await fs.readFile(path.join(folder, "package.json"), "utf8"));
				const themes = manifest.contributes?.themes ?? [];
				if (themes.some((theme) => theme.label === label || theme.id === label)) {
					return folder;
				}
			} catch {
				// Not an extension, or an unreadable manifest: keep looking.
			}
		}
	}

	return undefined;
}

/**
 * Stand-ins for the clipboard tools Copy Dashboard Image runs, placed first on the instance's PATH. Each keeps
 * the PNG it is handed at COPY_OUTPUT: osascript and xclip take the file as their last argument, and wl-copy
 * reads it from stdin.
 */
async function writeClipboardStandIns(bin) {
	await fs.mkdir(bin, { recursive: true });
	const header = "#!/bin/sh\n# Installed by make screenshots: keep the PNG instead of writing the clipboard.\n";
	const lastArgument = `${header}for last; do :; done\ncp "$last" "$COPY_OUTPUT"\n`;
	await fs.writeFile(path.join(bin, "osascript"), lastArgument, { mode: 0o755 });
	await fs.writeFile(path.join(bin, "xclip"), lastArgument, { mode: 0o755 });
	await fs.writeFile(path.join(bin, "wl-copy"), `${header}cat > "$COPY_OUTPUT"\n`, { mode: 0o755 });
}

/** Write the profile: quiet settings, the theme, and a day already under way. */
async function prepareProfile(profile, theme) {
	const user = path.join(profile, "user-data", "User");
	await fs.mkdir(path.join(user, "globalStorage", EXTENSION_ID), { recursive: true });
	await fs.mkdir(path.join(profile, "fixture"), { recursive: true });

	const settings = {
		"workbench.colorTheme": theme,
		"workbench.startupEditor": "none",
		"workbench.tips.enabled": false,
		"workbench.secondarySideBar.defaultVisibility": "hidden",
		"workbench.layoutControl.enabled": false,
		"window.restoreWindows": "none",
		"window.commandCenter": false,
		"chat.disableAIFeatures": true,
		"telemetry.telemetryLevel": "off",
		"update.mode": "none",
		"extensions.autoCheckUpdates": false,
		"extensions.autoUpdate": false,
		"security.workspace.trust.enabled": false,
		"git.enabled": false,
		"cursorApprove.enabled": false,
	};
	await fs.writeFile(path.join(user, "settings.json"), JSON.stringify(settings, null, "\t"));

	// The checkpoint is now, so the extension folds only the time it actually polls on top of the seed.
	const record = {
		version: await sharedDailyVersion(),
		date: localDateKey(),
		activeMs: SEEDED_TODAY.activeMs,
		lastCheckpointAt: Date.now(),
		unsuccessfulAttempts: 0,
		approvals: SEEDED_TODAY.approvals,
	};
	await fs.writeFile(path.join(user, "globalStorage", EXTENSION_ID, "daily-metrics.json"), JSON.stringify(record));
}

/**
 * Environment for the instance, without the host editor's variables. Run from Cursor's terminal, they would
 * point the instance at that editor, its sandbox, or its agent.
 */
function instanceEnvironment(profile, bin) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !/^(VSCODE|ELECTRON|CURSOR)_/.test(key)) {
			env[key] = value;
		}
	}

	return {
		...env,
		// Cursor, like VS Code, keeps a shared-storage database in the home folder, outside --user-data-dir.
		HOME: path.join(profile, "home"),
		PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
		// Launched from a CLI, Cursor keeps this environment instead of replacing it with a login shell's.
		VSCODE_CLI: "1",
		// The fixture does nothing without this, so it can only act inside this instance.
		CURSOR_APPROVE_FIXTURE_DIR: path.join(profile, "fixture"),
		COPY_OUTPUT: path.join(profile, "copy.png"),
	};
}

/**
 * A drawn pointer, since a capture from inside the renderer has no system cursor in it. It ignores events,
 * so hovering and clicking still reach the workbench underneath.
 */
async function installPointer(page) {
	await page.evaluate(() => {
		// The workbench enforces Trusted Types, so the SVG is built node by node rather than through innerHTML.
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "24");
		svg.setAttribute("viewBox", "0 0 14 21");
		const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
		arrow.setAttribute("d", "M1 1 L1 16.5 L4.8 12.9 L7.6 19.4 L10.3 18.2 L7.6 11.9 L12.6 11.9 Z");
		arrow.setAttribute("fill", "#ffffff");
		arrow.setAttribute("stroke", "#000000");
		arrow.setAttribute("stroke-width", "1.1");
		arrow.setAttribute("stroke-linejoin", "round");
		svg.append(arrow);

		const pointer = document.createElement("div");
		pointer.id = "screenshot-pointer";
		Object.assign(pointer.style, {
			position: "fixed",
			left: "-100px",
			top: "-100px",
			pointerEvents: "none",
			zIndex: "2147483647",
			filter: "drop-shadow(0 1px 1px rgba(0, 0, 0, 0.4))",
		});
		pointer.append(svg);

		// A click has no visible feedback of its own, so a ring expands from the pointer's tip.
		const ring = document.createElement("div");
		ring.id = "screenshot-click";
		Object.assign(ring.style, {
			position: "fixed",
			left: "-100px",
			top: "-100px",
			width: "0px",
			height: "0px",
			border: "2px solid rgba(255, 255, 255, 0.9)",
			borderRadius: "50%",
			pointerEvents: "none",
			zIndex: "2147483646",
			opacity: "0",
		});
		document.body.append(ring, pointer);
	});
}

/** Draw the click ring centered on (x, y), or hide it with a size of zero. */
async function setClickRing(page, { x, y }, size, opacity) {
	await page.evaluate(([left, top, diameter, alpha]) => {
		const ring = document.getElementById("screenshot-click");
		if (ring) {
			Object.assign(ring.style, {
				left: `${left - diameter / 2 - 2}px`,
				top: `${top - diameter / 2 - 2}px`,
				width: `${diameter}px`,
				height: `${diameter}px`,
				opacity: String(alpha),
			});
		}
	}, [x, y, size, opacity]);
}

/** Move the real mouse and the drawn pointer together. */
async function movePointer(page, x, y) {
	await page.mouse.move(x, y);
	await page.evaluate(([left, top]) => {
		const pointer = document.getElementById("screenshot-pointer");
		if (pointer) {
			pointer.style.left = `${left - 1}px`;
			pointer.style.top = `${top - 1}px`;
		}
	}, [x, y]);
}

/** Show or hide the drawn pointer, which belongs in the GIF but would cover the item's label in a still. */
async function showPointer(page, visible) {
	await page.evaluate((shown) => {
		const pointer = document.getElementById("screenshot-pointer");
		if (pointer) {
			pointer.style.visibility = shown ? "visible" : "hidden";
		}
	}, visible);
}

/**
 * Waits, briefly, for any hover's fade-in to finish. Cursor fades the dashboard in again every time its content
 * changes, and a frame sampled mid-fade held a half-drawn dashboard that played back as a flicker on each count.
 */
async function settleHoverFade(page) {
	await page
		.waitForFunction(
			() =>
				![...document.querySelectorAll(".monaco-hover")].some((hover) =>
					hover.getAnimations().some((animation) => animation.playState === "running")
				),
			undefined,
			{ polling: "raf", timeout: 500 },
		)
		.catch(() => undefined);
}

/**
 * Records GIF frames with explicit durations, so playback speed does not depend on capture speed. A capture
 * identical to the frame before it only lengthens that frame, so a still stretch costs one image.
 */
class Storyboard {
	constructor(page, directory, clip) {
		this.page = page;
		this.directory = directory;
		this.clip = clip;
		/** @type {{ file: string, durationMs: number }[]} */
		this.frames = [];
		/** @type {Buffer | undefined} */
		this.lastImage = undefined;
		this.pointer = { x: 0, y: 0 };
	}

	/** Capture the region and show it for `durationMs`. Resolves whether it differed from the last frame. */
	async frame(durationMs) {
		await settleHoverFade(this.page);
		const image = await this.page.screenshot({ clip: this.clip });
		const previous = this.frames.at(-1);
		if (previous !== undefined && this.lastImage?.equals(image)) {
			previous.durationMs += durationMs;
			return false;
		}

		const file = path.join(this.directory, `frame-${String(this.frames.length).padStart(3, "0")}.png`);
		await fs.writeFile(file, image);
		this.frames.push({ file, durationMs });
		this.lastImage = image;
		return true;
	}

	/**
	 * Record in real time: sample the region until `until` holds and at least `minMs` has passed, showing each
	 * distinct image for as long as it was on screen, but no longer than `capMs`.
	 */
	async watch({ minMs = 0, capMs = Infinity, until = async () => true, timeoutMs = 30_000, description = "" }) {
		const start = Date.now();
		let sampledAt = start;
		let held = 0;

		for (;;) {
			await delay(WATCH_INTERVAL_MS);
			const now = Date.now();

			// The time since the last sample belongs to the image that was showing through it.
			const showing = this.frames.at(-1);
			if (showing !== undefined) {
				const credit = Math.min(now - sampledAt, Math.max(0, capMs - held));
				showing.durationMs += credit;
				held += credit;
			}
			sampledAt = now;

			if (await this.frame(0)) {
				held = 0;
			}
			if (now - start >= minMs && (await until())) {
				break;
			}
			if (now - start > timeoutMs) {
				throw new Error(`Timed out waiting for ${description || "the tour"}`);
			}
		}

		const last = this.frames.at(-1);
		if (last !== undefined && last.durationMs === 0) {
			last.durationMs = WATCH_INTERVAL_MS;
		}
	}

	async place(x, y) {
		this.pointer = { x, y };
		await movePointer(this.page, x, y);
	}

	/** Click where the pointer is, with an expanding ring standing in for the click's feedback. */
	async click() {
		await this.page.mouse.down();
		await this.page.mouse.up();
		for (const [size, opacity] of [[10, 0.9], [20, 0.7], [30, 0.45], [40, 0.2]]) {
			await setClickRing(this.page, this.pointer, size, opacity);
			await this.frame(GLIDE_FRAME_MS);
		}
		await setClickRing(this.page, this.pointer, 0, 0);
	}

	/** Ease the pointer to (x, y), one frame per step. */
	async glide(x, y, frames = GLIDE_FRAMES) {
		const from = this.pointer;
		let moved = false;
		for (let step = 1; step <= frames; step += 1) {
			const t = step / frames;
			const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
			await movePointer(this.page, from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
			moved = (await this.frame(GLIDE_FRAME_MS)) || moved;
		}
		this.pointer = { x, y };

		// The drawn pointer moved, so identical captures mean the window stopped painting.
		if (!moved) {
			throw new Error("The Cursor window stopped repainting; keep it on screen until the capture finishes");
		}
	}

	/** Assemble the frames into a looping GIF through FFmpeg's concat demuxer and a generated palette. */
	async writeGif(output) {
		const list = path.join(this.directory, "frames.txt");
		const lines = this.frames.flatMap(({ file, durationMs }) => [`file '${file}'`, `duration ${durationMs / 1000}`]);
		// The concat demuxer drops the last frame's duration unless the frame is listed once more.
		lines.push(`file '${this.frames.at(-1)?.file}'`);
		await fs.writeFile(list, `${lines.join("\n")}\n`);

		await execFileAsync("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			list,
			"-filter_complex",
			"[0:v]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none",
			"-fps_mode",
			"vfr",
			"-loop",
			"0",
			output,
		]);
	}
}

async function statusItemBox(page) {
	const box = await page.locator(STATUS_ITEM).boundingBox();
	if (!box) {
		throw new Error("Cursor Approve's status bar item is not visible");
	}
	return box;
}

async function isActive(page) {
	return (await page.locator(`${STATUS_ITEM} .codicon-check-all`).count()) > 0;
}

/**
 * Whether no status bar message is showing. The extension shows one for two seconds after a toggle or a copy,
 * and removing it rebuilds the status bar, which closes an open hover until the pointer next moves.
 */
async function noStatusMessage(page) {
	return (await page.locator('[id="status.extensionMessage"]').count()) === 0;
}

/** The window's layout size, which the crops are measured against. */
async function viewportSize(page) {
	const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
	return { width, height };
}

/** The dashboard hover, whether or not it is open. */
function dashboardHover(page) {
	return page.locator(".monaco-hover, .workbench-hover").filter({ hasText: "Cursor Approve" }).last();
}

async function hoverText(hover) {
	return (await hover.innerText()).replace(/\s+/g, " ");
}

/** The Current Window row's approval count, or -1 while the dashboard is closed or has no such row. */
async function currentWindowApprovals(hover) {
	if (!(await hover.isVisible())) {
		return -1;
	}
	const match = /Current Window \S+ ([\d,]+) Auto Approved/.exec(await hoverText(hover));
	return match ? Number(match[1].replaceAll(",", "")) : -1;
}

/** Ask the fixture for `count` approval requests; it makes them once polling starts. */
async function requestApprovals(profile, count) {
	await fs.writeFile(path.join(profile, "fixture", "control.json"), JSON.stringify({ requests: count }));
}

/**
 * The README tour, written as auto-approve.gif to `outputDir`: switch approval on from the status bar, watch
 * the dashboard count the fixture's requests as they are approved, then switch it off again, ending where it
 * began so the loop has no seam. The two dashboard stills are taken mid-tour, while the hover shows the final
 * count, so all three images agree.
 */
async function captureTour(page, profile, framesDir, outputDir, version) {
	const item = await statusItemBox(page);
	const viewport = await viewportSize(page);
	const clip = {
		x: viewport.width - GIF_REGION.width,
		y: viewport.height - GIF_REGION.height,
		width: GIF_REGION.width,
		height: GIF_REGION.height,
	};
	const board = new Storyboard(page, framesDir, clip);
	const hover = dashboardHover(page);

	// The tip lands near the item's top-right corner, so the icon that changes stays in view and the arrow is
	// not cut off by the window's bottom edge. The resting spot sits left of where the dashboard opens: a pointer
	// inside an open hover holds it open.
	const target = { x: item.x + item.width - 16, y: item.y + 5 };
	const resting = { x: clip.x + 70, y: item.y - 44 };

	log("Recording the tour");
	await board.place(resting.x, resting.y);
	await board.frame(1000);
	await board.glide(target.x, target.y);
	await board.frame(300);

	await board.click();
	await waitFor("approval to switch on", () => isActive(page), 10_000, 50);

	// The toggle's status bar message rebuilds the status bar as it appears and again as it clears, and a hover
	// that opens across a rebuild can leave the item's dashboard refusing to open again. The pointer waits beside
	// the item until the message has gone, which also lifts the click's suppression of the item's hover.
	const beside = { x: target.x - 10, y: item.y - 18 };
	await board.glide(beside.x, beside.y, 5);
	await board.watch({
		description: "the toggle's status bar message to clear",
		minMs: 250,
		capMs: WATCH_HOLD_CAP_MS,
		until: () => noStatusMessage(page),
	});
	await openDashboard(board, hover, target, beside);

	// The fixture's requests start only now, so the dashboard counts them from zero, redrawing in place as each
	// approval lands.
	await requestApprovals(profile, WINDOW_APPROVALS);
	await board.watch({
		description: "the dashboard to count the fixture's approvals",
		capMs: WATCH_HOLD_CAP_MS,
		until: async () => (await currentWindowApprovals(hover)) >= WINDOW_APPROVALS,
	});
	await board.watch({ minMs: 1800 });

	const box = await hover.boundingBox();
	if (!box || box.x < clip.x || box.y < clip.y || box.x <= resting.x) {
		throw new Error("The dashboard does not fit the GIF region beside the resting pointer; widen GIF_REGION");
	}

	log("Capturing the dashboard");
	await captureDashboard(page, hover, item, path.join(outputDir, "dashboard.png"), version);
	await captureCopy(page, hover, profile, path.join(outputDir, "dashboard-copy.png"));

	// Reopen the dashboard as the tour left it, so the pause for the stills does not show.
	await movePointer(page, resting.x, resting.y);
	await waitFor("the dashboard to close", async () => !(await hover.isVisible()), 10_000);
	await waitFor("the copy's status bar message to clear", () => noStatusMessage(page), 10_000);
	await board.place(target.x, target.y);
	await hover.waitFor({ state: "visible", timeout: 10_000 });
	await delay(600);

	log("Finishing the tour");
	await board.watch({ minMs: 300 });
	await board.click();
	await waitFor("approval to switch off", async () => !(await isActive(page)), 10_000, 50);
	await board.watch({ minMs: 300 });
	await board.glide(resting.x, resting.y);
	await board.watch({
		minMs: 800,
		description: "the dashboard to close",
		until: async () => !(await hover.isVisible()),
	});

	await board.writeGif(path.join(outputDir, "auto-approve.gif"));
	const seconds = board.frames.reduce((total, { durationMs }) => total + durationMs, 0) / 1000;
	log(`  GIF has ${board.frames.length} frames, ${seconds.toFixed(1)}s`);
}

/**
 * Settle the pointer back on the item from `beside` and wait for the dashboard to open, drifting off and back
 * again if it does not.
 */
async function openDashboard(board, hover, target, beside) {
	const attempts = 3;
	for (let attempt = 1;; attempt += 1) {
		if (attempt > 1) {
			await board.glide(beside.x, beside.y, 5);
		}
		await board.glide(target.x, target.y, 5);
		try {
			await board.watch({
				description: "the dashboard to open",
				capMs: WATCH_HOLD_CAP_MS,
				timeoutMs: 3_000,
				until: async () => (await currentWindowApprovals(hover)) >= 0,
			});
			return;
		} catch (error) {
			if (attempt === attempts) {
				throw error;
			}
		}
	}
}

/** Save the open dashboard and the status bar item under it, after confirming it shows what was arranged. */
async function captureDashboard(page, hover, item, output, version) {
	const text = await hoverText(hover);

	const expected = [
		`v${version}`,
		`${WINDOW_APPROVALS} Auto Approved`,
		`${SEEDED_TODAY.approvals + WINDOW_APPROVALS} Auto Approved`,
	];
	for (const fragment of expected) {
		if (!text.includes(fragment)) {
			throw new Error(`Dashboard is missing "${fragment}": ${text}`);
		}
	}
	if (text.includes("Unavailable")) {
		throw new Error(`Dashboard reports the approval command unavailable: ${text}`);
	}

	const box = await hover.boundingBox();
	if (!box) {
		throw new Error("Dashboard hover has no bounding box");
	}
	const viewport = await viewportSize(page);
	const margin = 14;
	const left = Math.max(0, Math.min(box.x, item.x) - margin);
	const top = Math.max(0, box.y - margin);
	const right = Math.min(viewport.width, Math.max(box.x + box.width, item.x + item.width) + margin);
	await showPointer(page, false);
	await page.screenshot({
		path: output,
		clip: { x: left, y: top, width: right - left, height: viewport.height - top },
	});
	await showPointer(page, true);
}

/** Click the hover's camera link, which renders the PNG through the extension's own copy webview. */
async function captureCopy(page, hover, profile, output) {
	const copied = path.join(profile, "copy.png");
	await hover.locator('a[title="Copy dashboard image"]').click();
	await waitFor("the copy PNG", async () => {
		try {
			return (await fs.stat(copied)).size > 0;
		} catch {
			return false;
		}
	});
	// The stand-in may still be writing when the file first appears.
	await delay(300);
	await fs.copyFile(copied, output);
}

async function main() {
	const manifest = JSON.parse(await fs.readFile(path.join(REPO, "package.json"), "utf8"));
	const version = String(manifest.version);

	try {
		await fs.access(CURSOR_APP);
	} catch {
		throw new Error(`Cursor was not found at ${CURSOR_APP}; set CURSOR_APP to its executable`);
	}

	const themeExtension = await findThemeExtension(THEME);
	const theme = themeExtension !== undefined || THEME === FALLBACK_THEME ? THEME : FALLBACK_THEME;
	if (theme !== THEME) {
		log(`  theme "${THEME}" is not installed; using "${FALLBACK_THEME}"`);
	}

	for (let attempt = 1;; attempt += 1) {
		try {
			await captureInFreshInstance(version, theme, themeExtension, attempt === ATTEMPTS);
			return;
		} catch (error) {
			if (attempt === ATTEMPTS) {
				throw error;
			}
			const reason = error instanceof Error ? error.message : String(error);
			log(`  attempt ${attempt} of ${ATTEMPTS} failed (${reason}); starting a fresh instance`);
		}
	}
}

/**
 * Launches one throwaway instance, runs the tour in it, and copies the images to OUTPUT_DIR once all of them
 * exist, so a run that fails partway leaves the previous images in place rather than a mismatched set. A failed
 * attempt's profile is deleted unless it is the last one or KEEP_PROFILE is set.
 */
async function captureInFreshInstance(version, theme, themeExtension, lastAttempt) {
	// Cursor listens on a socket inside --user-data-dir, and a Unix socket path is capped at 103 characters,
	// which the macOS per-user temporary folder alone comes close to.
	const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
	const profile = await fs.mkdtemp(path.join(temporaryRoot, "cursor-approve-screenshots-"));
	await fs.mkdir(path.join(profile, "home"));
	const bin = path.join(profile, "bin");
	const framesDir = path.join(profile, "frames");
	const stagingDir = path.join(profile, "output");
	await fs.mkdir(framesDir, { recursive: true });
	await fs.mkdir(stagingDir, { recursive: true });

	await prepareProfile(profile, theme);
	await writeClipboardStandIns(bin);

	const developmentPaths = [REPO, FIXTURE, ...(themeExtension && theme === THEME ? [themeExtension] : [])];

	const app = await electron.launch({
		executablePath: CURSOR_APP,
		args: [
			// A fresh profile opens the Agents window, and both it and the editor window's onboarding demand a
			// sign-in. These open the editor window and skip its onboarding, so the instance runs signed out:
			// it needs no account, and no credentials are ever copied into it.
			"--classic",
			"--skip-onboarding",
			"--suppress-popups-on-startup",
			`--user-data-dir=${path.join(profile, "user-data")}`,
			`--extensions-dir=${path.join(profile, "extensions")}`,
			`--logsPath=${path.join(profile, "logs")}`,
			...developmentPaths.map((folder) => `--extensionDevelopmentPath=${folder}`),
			"--skip-welcome",
			"--skip-release-notes",
			"--disable-telemetry",
			"--disable-updates",
			"--disable-workspace-trust",
			"--disable-crash-reporter",
			"--force-disable-user-env",
			// Keeps the instance's safe storage out of the user's login keychain.
			"--use-mock-keychain",
			// Chromium stops painting a window that another one covers, and captures then repeat the last
			// frame. These keep it painting while the user works in front of it.
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--disable-background-timer-throttling",
			// GPU compositing dithers the hover's translucent layers differently from frame to frame, so two
			// captures of an unchanged dashboard differed by a level and every idle sample became a GIF frame.
			"--disable-gpu",
			"--force-device-scale-factor=2",
			"--new-window",
		],
		env: instanceEnvironment(profile, bin),
	});

	let succeeded = false;
	const page = await app.firstWindow();

	try {
		const cursorVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
		log(`  Cursor ${cursorVersion}, theme "${theme}", Cursor Approve v${version}`);
		await app.evaluate(({ BrowserWindow }, size) => {
			const [window] = BrowserWindow.getAllWindows();
			window.setContentSize(size.width, size.height);
			window.center();
			// The real mouse passes through, so the user's pointer crossing the window cannot take the hover
			// from the scripted one. Playwright's input reaches the renderer directly and is unaffected.
			window.setIgnoreMouseEvents(true);
		}, WINDOW);
		await page.locator(STATUS_ITEM).waitFor({ state: "visible", timeout: 60_000 });
		// Startup notifications and the status bar settle in the first few seconds.
		await delay(3000);
		await installPointer(page);

		await captureTour(page, profile, framesDir, stagingDir, version);
		await fs.mkdir(OUTPUT_DIR, { recursive: true });
		for (const name of OUTPUTS) {
			const output = path.join(OUTPUT_DIR, name);
			await fs.copyFile(path.join(stagingDir, name), output);
			log(`  wrote ${display(output)}`);
		}
		succeeded = true;
	} catch (error) {
		await page.screenshot({ path: path.join(profile, "failure.png") }).catch(() => undefined);
		throw error;
	} finally {
		await app.close().catch(() => undefined);
		if (KEEP_PROFILE || (!succeeded && lastAttempt)) {
			log(`  profile kept at ${profile}`);
		} else {
			await fs.rm(profile, { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
