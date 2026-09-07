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

| Item                   | Value                                   |
| ---------------------- | --------------------------------------- |
| Language               | TypeScript                              |
| Runtime API            | VS Code extension API (`@types/vscode`) |
| Host                   | Cursor only                             |
| Build                  | `tsc` to `out/`, then `vsce package`    |
| Formatting             | dprint using the project `dprint.json`  |
| Script logging         | `scripts/log.bash`                      |
| Development entrypoint | `make`                                  |

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
4. To test the packaged build, run `make package`, install the resulting `.vsix` with the Cursor CLI, and reload the
   regular Cursor window.

Useful verification commands in the Extension Development Host:

- **Cursor Approve: Show Diagnostics** opens the Output panel with the **Cursor Approve** channel selected. Ensure the
  Output panel log level includes **Info**.
- **Cursor Approve: List Cursor Composer Commands** lists all registered `composer.*` commands and confirms the
  extension's approval commands are available.

## Version and Release

| File           | Role                                                    |
| -------------- | ------------------------------------------------------- |
| `VERSION`      | Source of truth for the extension version               |
| `package.json` | Synced by `make bump-version`                           |
| `README.md`    | VSIX install examples are synced by `make bump-version` |
| `CHANGELOG.md` | Manual release notes; update for each release           |

After editing `VERSION`, always run `make bump-version`. The release workflow is:

```bash
echo "X.Y.Z" > VERSION
make bump-version
make lint
make fmt-check
make package
```

Update `CHANGELOG.md`, tag the release, and push only when explicitly requested.

## Agent Guidelines

### Do

- Use `make` targets for dependency checks, builds, linting, formatting, and packaging.
- Run `make lint` and `make fmt-check` before finishing substantive changes.
- For Markdown, run dprint with `~/.config/dprint/dprint.json`; use aligned GFM tables and language-tagged code fences.
- Source `scripts/log.bash` in new Bash scripts instead of recreating logging helpers.
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
