# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The active status bar item now follows the theme's accent colour instead of using the amber warning background,
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
