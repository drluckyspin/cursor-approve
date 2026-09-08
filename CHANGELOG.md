# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
