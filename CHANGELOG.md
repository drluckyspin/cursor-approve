# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A theme-native status-bar dashboard with the extension logo, configuration state, how long automatic approval has been
  active this session and today, and safe links to toggle approval, open diagnostics, and open settings.
- The dashboard reports an unavailable approval command, unsuccessful attempts, focused-window-only approval, and
  `allowlist` mode as dedicated lines only while those conditions apply, keeping the hover readable.
- `cursorApprove.statusBarPriority` positions the status bar item within the right-hand group.
- Active-time metrics persist across extension-host reloads and reset on the user's local calendar day.
- An experimental approval probe records terminal activity an approved shell tool call would produce, reported only
  through debug logs and **Show Diagnostics**, to establish whether real approvals are observable at all.

### Changed

- The dashboard no longer reports approval-command invocations. Cursor's command resolves the same way whether it
  approved a request or found nothing pending, so the count only restated the poll interval and implied activity the
  extension cannot measure.
- The dashboard stays current instead of holding a snapshot: it is rebuilt each poll and reassigned only when its
  rendered text changes, which at minute granularity avoids redrawing a hovered tooltip.
- The extension now requires VS Code 1.93 or later for the terminal shell integration API used by the approval probe.

### Fixed

- **Show Diagnostics** could leave the previously selected Output channel in place. Revealing the panel restores that
  channel asynchronously, so the extension now selects its own channel after the view settles.
- Active time counted hours the machine spent suspended, because it was derived from a single start timestamp. Each
  interval is now folded in as it passes and a gap far longer than the poll interval is discarded.
- The dashboard could report the previous day's total after midnight while automatic approval was off, since no poll was
  running to notice the date change. The daily bucket now rolls when the dashboard is rendered and at local midnight.
- The approval probe no longer reads terminal command lines. The event covers every execution the host exposes,
  including commands the user typed, whose arguments routinely carry secrets.
- Deactivation no longer rejects when the final metrics write fails; the failure is logged instead.
- Command availability now checks the command for the configured mode and is rechecked when the mode changes, so a
  missing `allowlist` command is reported instead of being masked by the `run` command's presence.
- **Active since** reports the current stretch after a suspend gap is discarded, and includes the date when the stretch
  began on an earlier day.
- Repeated approval failures no longer force an extension-storage write on every poll.
- Daily metrics are stored under a new key, so totals recorded by a build that counted suspended time are discarded
  rather than carried into the corrected accounting.

## [0.3.2] - 2026-09-09

### Changed

- Diagnostics now reliably select the **Cursor Approve** Output channel, and the status-bar hover tooltip exposes a
  compact state snapshot without flickering during successful polling.
- User-facing diagnostics call failed approval-command invocations "unsuccessful attempts" rather than errors.

## [0.3.1] - 2026-09-08

### Added

- Extension icon (`logo512.png`) in the marketplace manifest and README header.
- GitHub Actions release workflow to build and upload a VSIX when a release is published.
- Automated CHANGELOG and README release history updates when a GitHub release is published.

### Changed

- `make bump-version` accepts the target version as an argument.
- `make install` packages the extension and installs it through the Cursor CLI.

## [0.3.0] - 2026-09-07

### Added

- A Makefile workflow for building, linting, formatting, packaging, installing, and synchronizing release versions.
- `AGENTS.md` instructions for development, release maintenance, and safety constraints.

### Changed

- `Show Diagnostics` and `List Cursor Composer Commands` now focus the **Cursor Approve** Output channel when run from
  the Command Palette.
- Documentation and screenshots now clarify approval modes, safety trade-offs, and the extension development workflow.
- Packaged VSIX files now exclude development-only tooling and agent instructions.

## [0.2.0] - 2026-09-04

### Changed

- The active status bar item now follows the theme's accent color instead of using the amber warning background,
  configurable through `cursorApprove.activeColor`.
- Added `cursorApprove.statusBarStyle` to choose between `foreground`, `background`, and `none` highlighting.
- `Show Diagnostics` and `List Cursor Composer Commands` now focus the output channel rather than revealing it behind
  the current panel.

## [0.1.0] - 2026-09-04

### Added

- Automatic approval of pending agent tool calls by invoking `composer.approvePendingShellToolDecision`.
- `run` and `allowlist` approval modes, matching Cursor's **Run** and **Always Run** buttons.
- Status bar toggle that turns amber while automatic approval is active.
- `Show Diagnostics` command reporting poll counts, errors, and command availability.
- `List Cursor Composer Commands` command for discovering Cursor's undocumented `composer.*` commands.
- `onlyWhenFocused` setting to restrict approval to the focused window.
- Automatic shutdown after three consecutive failures invoking the approval command.
