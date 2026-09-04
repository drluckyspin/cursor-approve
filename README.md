# Cursor Approve

A Cursor extension that automatically approves the agent's pending tool calls, so long-running agent sessions do not
stall waiting for you to click **Run**.

It does this by invoking Cursor's own approval command rather than by simulating keystrokes or detecting the button on
screen. That makes it independent of your theme, window position, and display scaling, and it cannot leak a stray
`Enter` into your editor.

## Requirements

Cursor. This extension will install into stock VS Code but does nothing there, because the commands it calls are
registered by Cursor's agent panel. It logs a warning on activation if those commands are missing.

## How it works

Cursor registers its approval actions as ordinary workbench commands:

| Command                                             | Equivalent UI button |
| --------------------------------------------------- | -------------------- |
| `composer.approvePendingShellToolDecision`          | Run                  |
| `composer.approvePendingShellToolDecisionAllowlist` | Always Run           |
| `composer.skipPendingShellToolDecision`             | Skip                 |

They are declared with `f1: true`, which means they appear in the Command Palette and can be invoked by an extension
through `vscode.commands.executeCommand`.

Cursor gates the matching keybindings behind a context key, `composerShellToolPendingKeybindingsActive`, that is only
true while a tool call is awaiting a decision. Extensions cannot read context keys, so this extension polls instead.
Polling is safe because the underlying handler returns early when there is nothing pending:

```js
const g = p.getPendingUserDecisionGroup()();
const f = jAh(g);
if (!f) return; // nothing pending, no-op
```

Calling the command on a timer is therefore a genuine no-op most of the time, with no side effects.

## Install

From a packaged build:

```bash
cursor --install-extension cursor-approve-0.1.0.vsix
```

From source:

```bash
git clone https://github.com/drluckyspin/cursor-approve.git
cd cursor-approve
npm install
npm run package
cursor --install-extension cursor-approve-0.1.0.vsix
```

## Usage

Automatic approval is **off** by default. Enable it from the status bar item, the Command Palette, or settings.

| Command                                          | Description                                     |
| ------------------------------------------------ | ----------------------------------------------- |
| `Cursor Approve: Toggle Automatic Approval`      | Turn polling on or off                          |
| `Cursor Approve: Approve Pending Tool Call Once` | Send a single approval without enabling polling |
| `Cursor Approve: Show Diagnostics`               | Print current state to the output channel       |
| `Cursor Approve: List Cursor Composer Commands`  | Dump every registered `composer.*` command      |

### Settings

| Setting                           | Type      | Default | Description                                                 |
| --------------------------------- | --------- | ------- | ----------------------------------------------------------- |
| `cursorApprove.enabled`           | `boolean` | `false` | Poll for pending tool calls and approve them                |
| `cursorApprove.intervalMs`        | `number`  | `1000`  | How often to check, in milliseconds                         |
| `cursorApprove.mode`              | `string`  | `run`   | `run` approves once, `allowlist` also remembers the command |
| `cursorApprove.onlyWhenFocused`   | `boolean` | `false` | Only approve while this window has focus                    |
| `cursorApprove.showStatusBarItem` | `boolean` | `true`  | Show the status bar toggle                                  |

The status bar item turns amber while automatic approval is active, so an unattended session is never silently armed.

## Development

Open the folder in Cursor and press <kbd>F5</kbd> to launch an Extension Development Host with the extension loaded.

```bash
npm install
npm run watch      # incremental compile
npm run lint       # type check only
npm run package    # build a .vsix
```

The `Cursor Approve: List Cursor Composer Commands` command is the discovery tool used to find the approval commands in
the first place. Cursor's internal commands are undocumented and may be renamed between releases, so run it against a
new build before assuming anything still works.

## Safety

This bypasses a deliberate confirmation step. An agent that has been prompt-injected, or that simply misunderstands a
task, will be able to run shell commands without asking. Consider whether you want it enabled in repositories you do not
control.

Cursor also ships a built-in equivalent. In the agent panel's mode menu you can set tool approval to **Auto-review**,
which runs operations its classifier judges safe, or **Run Everything**, which approves all of them. If either fits your
needs, prefer it over this extension. Note that switching away from **Ask Every Time** removes that option from the menu
permanently.

## License

[MIT](LICENSE)
