# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A theme-native status-bar dashboard with the extension logo, configuration state, how long automatic approval has been
  active this session and today in an aligned column, and safe links to toggle approval, open diagnostics, open
  settings, and copy the dashboard as a PNG from the footer **camera** icon.
- **Copy Dashboard Image** renders the hover dashboard as a theme-accurate PNG on the clipboard for bug reports or chat.
  The Command Palette command and the footer camera icon share the same action; a short-lived editor tab opens while the
  image is rendered, then closes automatically.
- The dashboard reports an unavailable approval command, unsuccessful attempts, focused-window-only approval, and
  `allowlist` mode as dedicated lines only while those conditions apply, keeping the hover readable. The severity lines
  carry a pill colored from the status bar's error and warning colors.
- `cursorApprove.statusBarPriority` positions the status bar item within the right-hand group.
- Active-time metrics persist across extension-host reloads and reset on the user's local calendar day.
- The dashboard reports approvals against the commands that ran in Cursor's agent terminals while automatic approval was
  active, as `5/12 Auto Approved`, for the session and the current day. Agent terminals are identified by the
  `Agent Terminal` and `Cursor (` name prefixes Cursor uses internally, and the gap between the two numbers is the work
  Cursor auto-ran from its own allowlist or sandbox, which never needed an approval.
- The approved figure is attributed by timing: a command awaiting approval starts within about 50ms of the invocation
  that released it, while one Cursor auto-ran starts at an arbitrary point in the poll cycle.
- **Show Diagnostics** reports terminal activity per terminal name and the delay between invoking the approval command
  and an agent command starting, which is the measurement the attribution threshold is derived from.

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
- **Current Window** replaces the per-session row and measures exactly the span **Active since** names: it restarts when
  the machine wakes from a suspend and is cut at local midnight, and its counts restart with it. The previous row
  measured the extension host's lifetime, so it could report more time than the day beside it and carry yesterday's
  approvals into this morning's figures.
- Repeated approval failures no longer force an extension-storage write on every poll.
- Daily totals are shared correctly across Cursor windows. Each window runs its own extension host with its own copy of
  `globalState` and never sees another's writes, so whichever window checkpointed last overwrote the day's numbers. The
  totals now live in a file under the extension's global storage that each window re-reads and merges into: counts sum
  across windows, and active time is folded once from a shared checkpoint rather than once per window.
- Totals recorded by builds that counted suspended time or raced between windows are discarded rather than carried into
  the corrected accounting.
- Changing any `cursorApprove.*` setting while automatic approval was active restarted the current stretch, so editing
  the interval, mode, or a color reset **Active since** and discarded **Current Window** and its counts. A stretch now
  opens or closes only when the enabled state itself changes.
- A failed approval invocation left its timestamp in place, so an agent command that started within the attribution
  window could be counted as approved by a call that approved nothing.
- The day's totals went stale in a window with automatic approval switched off. Nothing polled there, so nothing re-read
  the shared record while other windows kept adding to it. The dashboard now re-reads it, rate-limited, and redraws only
  when the totals changed.
- **Current Window** could include time the machine spent suspended for up to one poll interval after waking, until the
  next poll discarded the gap, while the day's total beside it had already refused to count it.
- The copied image could render a mangled clock time. The dashboard snapshot is UTF-8 but the webview decoded it one
  byte per character, which was enough to corrupt an en-US time, since the meridiem is separated by a narrow no-break
  space.
- The midnight rollover redrew the dashboard without cutting the current stretch, so a hover taken before the next poll
  showed a window spanning yesterday beside a day total that had already reset.
- **Approve Pending Tool Call Once** fed the approval attribution, so a command the user released by hand could be
  counted on a row that reports automatic approvals.
- Copying the image on Linux required `xclip` specifically. `wl-copy` is now tried as well, and the error names both
  rather than reporting whichever ran last.
- PowerShell is now invoked with `-Sta`, which the clipboard API requires. Windows PowerShell has defaulted to it since
  3.0, so this is explicit rather than corrective.
- The PNG handed to the platform clipboard is written into a directory created by `mkdtemp` rather than to a name
  derived from the clock. The predictable path could be pre-created as a symlink by another local process, which would
  have made copying an image overwrite a file of that process's choosing.
- The temporary path reaches `osascript` as an argument read from `argv` instead of being interpolated into the script.
  It derives from `TMPDIR`, so a quote or newline in that variable could have ended the string literal and run the rest
  as AppleScript.
- With `onlyWhenFocused` enabled, working in another application for longer than the gap tolerance looked like a
  suspend, so returning to the window discarded the stretch and its counts.
- A settings change left nothing to measure the next gap from, so a machine that slept before the following poll counted
  the sleep as active until that poll arrived.
- Reloading the extension host within the fold tolerance counted the shutdown gap as active time. The corrected
  checkpoint was only held in memory, and merging re-reads the file.

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
