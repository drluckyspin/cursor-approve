# AGENTS.md — Cursor Approve

Guidance for coding agents working in this repository.

## What This Is

**Cursor Approve** is a Cursor extension that polls Cursor's undocumented approval commands to approve pending shell
tool calls. It deliberately does not simulate keystrokes, scrape the UI, or automate the screen.

- It requires **Cursor**. Stock VS Code does not register the `composer.*` commands it invokes.
- Automatic approval is **off by default**. Enabling it bypasses a deliberate confirmation step, so preserve that safety
  posture.
- The repository is [drluckyspin/cursor-approve](https://github.com/drluckyspin/cursor-approve), licensed under MIT.
- The current version is stored in root [`VERSION`](VERSION) and synchronized with `make bump-version`.

## Architecture

```text
Timer (cursorApprove.intervalMs)
  → vscode.commands.executeCommand(composer.approvePendingShellToolDecision)
    → Cursor returns immediately when no shell-tool decision is pending
    → Cursor approves the pending request when one exists
```

Cursor's approval commands are undocumented and can change between releases:

| Command                                             | `cursorApprove.mode` | UI equivalent  |
| --------------------------------------------------- | -------------------- | -------------- |
| `composer.approvePendingShellToolDecision`          | `run`                | **Run**        |
| `composer.approvePendingShellToolDecisionAllowlist` | `allowlist`          | **Always Run** |
| `composer.skipPendingShellToolDecision`             | N/A                  | **Skip**       |

Run **Cursor Approve: List Cursor Composer Commands** after upgrading Cursor to verify that the approval commands still
exist.

| Path                       | Role                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `src/extension.ts`         | Polling, commands, status bar, diagnostics, output channel |
| `package.json`             | Extension manifest, settings schema, npm scripts           |
| `Makefile` / `scripts/`    | Build tooling, logging, and version synchronization        |
| `VERSION`                  | Semantic-version source of truth                           |
| `.vscode/launch.json`      | F5 opens an Extension Development Host                     |
| `.github/workflows/ci.yml` | CI type-checks, compiles, packages, and uploads the VSIX   |

## Tech Stack

| Item                   | Value                                               |
| ---------------------- | --------------------------------------------------- |
| Language               | TypeScript                                          |
| Runtime API            | VS Code extension API (`@types/vscode`)             |
| Host                   | Cursor only                                         |
| Build                  | `npm install`, `tsc` to `out/`, then `vsce package` |
| Formatting             | dprint using the project `dprint.json`              |
| Script logging         | `scripts/log.bash`                                  |
| Development entrypoint | `make`                                              |

## Development Commands

Run commands from the repository root. **`make` is the only entrypoint**; do not suggest raw `npm run` commands in agent
responses.

```bash
make help
make check
make install
make build
make lint
make fmt
make fmt-check
make package
make bump-version
make clean
```

Set `VERBOSE=true` to retain unfiltered output from Makefile commands that use `log_run_dim`.

## Extension Development Workflow

1. Open this repository in Cursor and press **F5** to open a second Cursor window: **Extension Development Host**.
2. Test the extension in that dev-host window, not in the original editor window.
3. After source changes, run **Developer: Reload Window** in the dev host or stop and launch F5 again.
4. To test the packaged build, run `make install`, then reload the regular Cursor window.

Useful verification commands in the Extension Development Host:

- **Cursor Approve: Show Diagnostics** opens the Output panel with the **Cursor Approve** channel selected. The
  status-bar hover shows a theme-native Markdown dashboard with the time automatic approval has been active this session
  and today. Daily metrics persist through extension-host reloads; session metrics reset on activation. Ensure the
  Output panel log level includes **Info**.
- **Cursor Approve: List Cursor Composer Commands** lists all registered `composer.*` commands and confirms the
  extension's approval commands are available.

When changing dashboard metrics, preserve these safeguards:

- Approvals are counted from the window's Cursor renderer log, because nothing else reports them. Cursor's handler
  returns nothing whether it approved a request or found nothing pending, no command exposes the pending-decision state,
  and extensions cannot read the `composerShellToolPendingKeybindingsActive` context key. The renderer log records both
  halves of every request: `ComposerWakelockManager` releases a chat's wakelock with `user-approval-requested` when its
  agent stops to ask, and acquires one with `agent-loop-resumed` once the request is answered. The log sits two levels
  above `context.logUri`. Run **Show Diagnostics** after upgrading Cursor to confirm the log is still found and still
  logs requests.
- Read that log for those two lines only. Capture the timestamp, action, reason, and chat ID, and never copy, store, or
  log any other part of it. Start each extension host by replaying recent history to learn which requests are already
  pending, without counting anything from it.
- Credit a resolved request to this extension only when the agent resumed within `APPROVAL_RESUME_WINDOW_MS` of one of
  this window's poll calls returning, after the request was logged, and take that call so it is never credited twice. On
  Cursor 3.27.22 agents resumed 7 to 10ms after the call that released them, while a click on Run lands anywhere in the
  poll interval. A call from before the request cannot have released it, and without that check a click shortly after an
  idle poll counted. Record **Approve Pending Tool Call Once** calls too: one matched to a request consumes it without
  credit, because it was not approved automatically.
- Attribute each approval by when the agent resumed, not when the log was read, so one read after midnight or after the
  stretch restarted lands in neither. Discard approval calls by how far the log has been read, never by age: a poll
  interval of up to 30 seconds, or an `onlyWhenFocused` pause, would otherwise expire a call before its resume is read.
  Drain the log when polling stops and before the final merge on shutdown, since the next extension host replays it
  without counting.
- Never infer approvals from how long the approval call takes. With nothing pending, Cursor's handler took anywhere from
  4ms to a second, often in several windows at once, and timing it, even against a baseline call queued just ahead,
  counted dozens of approvals in idle windows. A log line that goes missing reads as zero rather than too many.
- Never count approvals from terminal executions. Chats on Cursor's Agent Host runtime, introduced in 3.27.12, run
  commands without a VS Code terminal, so `onDidStartTerminalShellExecution` never fires for them. For the rest, the
  same command runs whether this extension approved it, Cursor auto-ran it from its own allowlist, or the user clicked
  Run. The terminal probe stays in diagnostics.
- The day's totals live in `daily-metrics.json` under `globalStorageUri`, not in `globalState`. Every Cursor window runs
  its own extension host with its own in-memory copy of `globalState`, never sees another window's writes, and
  overwrites the shared value wholesale, which made the totals a race between windows. Keep the merge semantics: re-read
  immediately before writing, add counts as per-window deltas, and fold active time once from the shared checkpoint so
  concurrent windows cannot double-count a global setting. Write the file through a temporary file and an atomic rename:
  `vscode.workspace.fs.rename` with `overwrite` deletes the target first, and a window that read in that gap started the
  day over. Treat only a missing file as empty, and never write totals lower than ones this window has already seen
  today.
- Keep every dashboard value at minute granularity or coarser. The tooltip is rebuilt each tick and reassigned only when
  its rendered text changes, so a per-second value would redraw a hovered tooltip every second.
- Restrict trusted Markdown command links to the explicit dashboard command allowlist. Keep the tooltip background
  theme-controlled; extensions cannot customize it through VS Code's API.
- Never read `TerminalShellExecution.commandLine`. It fires for every execution the host exposes, including commands the
  user typed, and their arguments routinely carry tokens and other secrets. Terminal names are sufficient.
- Active time must accrue as it passes, not from a single start timestamp, so that time the machine spent suspended is
  discarded rather than reported as active. The gap tolerance follows the interval that opened the current checkpoint
  window, so that changing `intervalMs` cannot retroactively reclassify that window as suspended time.
- That applies to the window row too. Report `windowMetrics.activeMs`, banked by `updateActiveStretch` on the ticks that
  actually polled, never the span from `activeSince`. The span also covers a suspend and any interval skipped because
  `onlyWhenFocused` left the window in the background, neither of which the day's total folds, so reporting it made the
  two rows disagree.

## Version and Release

| File           | Role                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| `VERSION`      | Source of truth for the extension version                                                 |
| `package.json` | Synced by `make bump-version` (including `package-lock.json`)                             |
| `README.md`    | VSIX install examples synced by `make bump-version`                                       |
| `CHANGELOG.md` | `[Unreleased]` during development; finalized by `make update-release-docs` before tagging |

Use `make bump-version X.Y.Z` to update `VERSION` and synchronize the other version files. The release workflow is:

```bash
# Document changes under ## [Unreleased] in CHANGELOG.md while developing.
make bump-version X.Y.Z
make update-release-docs
make lint
make fmt-check
make package
# Merge to main, then tag vX.Y.Z, create the GitHub release, and publish it.
```

Finalize the CHANGELOG **before** tagging. The tag is what `.github/workflows/release.yml` builds from, so a
`[Unreleased]` heading at that point ships inside the VSIX and shows on the extension's Changelog tab.

Publishing a GitHub release runs that workflow, which packages the VSIX and uploads it to the release. It does not write
to the repository: the ruleset on `main` requires a pull request, and the GitHub Actions app cannot be granted a ruleset
bypass on a user-owned repository. Tag and push only when explicitly requested.

## Agent Guidelines

### Do

- Use `make` targets for dependency checks, builds, linting, formatting, and packaging.
- Run `make lint` and `make fmt-check` before finishing substantive changes.
- For Markdown, run dprint with `~/.config/dprint/dprint.json`; use aligned GFM tables and language-tagged code fences.
- Source `scripts/log.bash` in new Bash scripts instead of recreating logging helpers.
- Comment all code clearly enough to explain its purpose, non-obvious decisions, and safety-relevant behavior. Include a
  comment header in all files.
- Keep changes minimal, focused, and consistent with existing TypeScript style: tabs and double quotes.
- Test extension behavior in the Extension Development Host.

### Do not

- Commit `node_modules/`, `out/`, or `*.vsix`.
- Create commits or pull requests unless explicitly requested.
- Introduce keystroke simulation, screen scraping, or UI automation for tool approvals.
- Assume stock VS Code support for Cursor's `composer.*` commands.
- Add tests that only assert trivial behavior unless specifically requested.
- Edit unrelated files or add abstractions without a concrete need.

## Common Edit Locations

| Task                         | Files                              |
| ---------------------------- | ---------------------------------- |
| Approval logic and polling   | `src/extension.ts`                 |
| Commands and settings schema | `package.json`, `src/extension.ts` |
| Build and release tooling    | `Makefile`, `scripts/`, `VERSION`  |
| User documentation           | `README.md`, `CHANGELOG.md`        |
| Agent instructions           | `AGENTS.md`                        |
| Continuous integration       | `.github/workflows/ci.yml`         |

## Quick Reference

```bash
# Daily development
make check
make install
make build
# Press F5 in Cursor, then test in Extension Development Host.

# Before a release
make lint
make fmt-check
make package
```
